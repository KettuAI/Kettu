// The daemon's side of the hosts, as main's AgentHost, TerminalHost and RemoteHost are the app's:
// their init, what they ask of main, and what is left after a crash. The daemon has no windows,
// notifications, tray or browser, so what serves those is not answered; remote access is always on,
// and so are its direct connections.

import path from 'node:path'
import type {
  DirectStatus,
  HostToMain,
  MainToHost,
  MainToRemoteHost,
  MainToTerminalHost,
  RemoteHostStatus,
  RemoteHostToMain,
  TerminalHostToMain,
} from '@shared/host-control'
import type { Locale } from '@shared/locale'
import { isDirectStatus } from '@shared/remote/address'
import { isPairingState, type PairingState } from '@shared/remote/pairing'
import type { DirectSettings, SettingsFile } from '@shared/settings'
import { processControl, stopTrees, type ProcessId } from '../agent-host/process-tree'
import { createLogger } from '../main/log'
import { hostSettings, terminalSettings } from '../main/settings-schema'
import { ControlError, type DeviceSummary, type HostName, type HostStatus } from './control'
import { ForkedHost, type HostTimings } from './forked-host'

const log = createLogger('daemon')

const MAX_LIST = 10_000
const MAX_STRING = 8192
const MAX_DEVICES = 1000
/** How long an agent's tree gets between SIGTERM and SIGKILL after its host died, as in main. */
const GRACE_MS = 2_000
/** How long a removal waits for the remote host to report the device gone. */
const REMOVE_TIMEOUT_MS = 10_000
/** How long a change of the direct settings waits for the remote host to report what came of it. */
const DIRECT_WAIT_MS = 2_000

function isStringList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_LIST &&
    value.every((item) => typeof item === 'string' && item.length <= MAX_STRING)
  )
}

function isRemoteStatus(value: unknown): value is RemoteHostStatus {
  if (typeof value !== 'object' || value === null) return false
  const { publicKey, plainTextKey, devices, online, refused, direct } = value as Record<
    string,
    unknown
  >
  const isText = (item: unknown): boolean => typeof item === 'string' && item.length <= MAX_STRING
  return (
    typeof publicKey === 'string' &&
    typeof plainTextKey === 'boolean' &&
    Array.isArray(devices) &&
    devices.length <= MAX_DEVICES &&
    devices.every((device: unknown) => {
      if (typeof device !== 'object' || device === null) return false
      const { id, name, kind, platform, lastConnectedAt } = device as Record<string, unknown>
      return (
        [id, name, kind, platform].every(isText) &&
        (lastConnectedAt === null || Number.isFinite(lastConnectedAt))
      )
    }) &&
    Array.isArray(online) &&
    online.length <= MAX_DEVICES &&
    online.every(isText) &&
    Number.isSafeInteger(refused) &&
    isDirectStatus(direct)
  )
}

export interface HostsOptions {
  /** The folder of the daemon's build, which holds each host's bundle. */
  bundleDir: string
  dataPath: string
  version: string
  systemLocale: Locale
  settings(): SettingsFile
  /** The host's X25519 private key, in base64, for the remote host alone. */
  privateKey: string
  /** The name devices show for this computer. */
  hostName: string
  env: NodeJS.ProcessEnv
  timings?: HostTimings
}

type AnyHost = ForkedHost<unknown, { type: string }>

export class Hosts {
  private readonly agent: ForkedHost<MainToHost, HostToMain>
  private readonly terminal: ForkedHost<MainToTerminalHost, TerminalHostToMain>
  private readonly remote: ForkedHost<MainToRemoteHost, RemoteHostToMain>
  private projects: string[] = []
  private authCommands: string[] = []
  private agentProcesses: ProcessId[] = []
  private remoteStatus: RemoteHostStatus | null = null
  /** The direct settings the remote host was last given, as JSON. */
  private sentDirect: string | null = null
  private readonly settings: () => SettingsFile
  private readonly statusListeners = new Set<() => void>()
  private readonly askers = new Map<number, (pairing: PairingState) => void>()
  private nextCode = 1

  constructor(options: HostsOptions) {
    this.settings = options.settings
    const bundle = (name: string): string => path.join(options.bundleDir, name)
    this.agent = new ForkedHost<MainToHost, HostToMain>({
      log: createLogger('agent-host'),
      modulePath: bundle('agent-host.cjs'),
      socketName: 'agent-host',
      env: options.env,
      timings: options.timings,
      initMessage: (socketPath) => ({
        type: 'host:init',
        userDataPath: options.dataPath,
        appVersion: options.version,
        platform: process.platform,
        isPackaged: true,
        nodeRuntime: { command: process.execPath, env: {} },
        fakeAgentPath: options.env.KETTU_FAKE_AGENT || null,
        threadWorkerPath: bundle('thread-worker.cjs'),
        usageWorkerPath: bundle('usage-worker.cjs'),
        sessionRouterPath: bundle('session-router.cjs'),
        settings: hostSettings(options.settings(), options.systemLocale),
        socketPath: socketPath ?? undefined,
      }),
      shutdownMessage: { type: 'host:shutdown' },
      readyType: 'host:ready',
      stoppedType: 'host:stopped',
      onMessage: (message) => this.receive(message),
      onExit: (clean) => this.agentExited(clean),
    })
    this.terminal = new ForkedHost<MainToTerminalHost, TerminalHostToMain>({
      log: createLogger('terminal-host'),
      modulePath: bundle('terminal-host.cjs'),
      socketName: 'terminal-host',
      env: options.env,
      timings: options.timings,
      initMessage: (socketPath) => ({
        type: 'terminal-host:init',
        platform: process.platform,
        appVersion: options.version,
        settings: terminalSettings(options.settings()),
        projects: this.projects,
        authCommands: this.authCommands,
        socketPath: socketPath ?? undefined,
      }),
      shutdownMessage: { type: 'terminal-host:shutdown' },
      readyType: 'terminal-host:ready',
      stoppedType: 'terminal-host:stopped',
      onMessage: (message) => log.warn(`Ignored terminal host message "${message.type}"`),
    })
    // Devices reach it through its direct connections, as in the desktop app, not a socket.
    this.remote = new ForkedHost<MainToRemoteHost, RemoteHostToMain>({
      log: createLogger('remote-host'),
      modulePath: bundle('remote-host.cjs'),
      socketName: null,
      env: options.env,
      timings: options.timings,
      initMessage: () => ({
        type: 'remote-host:init',
        userDataPath: options.dataPath,
        appVersion: options.version,
        platform: process.platform,
        hostName: options.hostName,
        privateKey: options.privateKey,
        plainTextKey: true,
        direct: this.initDirect(),
        // The agent host's socket outlives its restarts, so a device's session finds it again.
        agentHostSocket: this.agent.socketPath ?? undefined,
      }),
      shutdownMessage: { type: 'remote-host:shutdown', reason: 'stopping' },
      readyType: 'remote-host:ready',
      stoppedType: 'remote-host:stopped',
      onMessage: (message) => this.receiveRemote(message),
      onExit: () => {
        this.setRemoteStatus(null)
        this.voidCodes()
      },
    })
  }

  /** Starts the agent host, then the remote host on its socket; the terminal host waits. */
  start(): void {
    this.agent.ready().then(
      () => this.remote.start(),
      () => log.error('Remote access does not start, since the agent host does not'),
    )
  }

  /** A host's socket once it is ready; rejects with `isUnavailable` when it cannot run. */
  async socket(name: HostName): Promise<string> {
    const host = name === 'agent' ? this.agent : this.terminal
    await host.ready()
    return host.socketPath!
  }

  status(): Record<HostName | 'remote', HostStatus> {
    const of = (host: AnyHost): HostStatus => ({
      state: host.state,
      pid: host.pid,
      restarts: host.restarts,
    })
    return { agent: of(this.agent), terminal: of(this.terminal), remote: of(this.remote) }
  }

  /** How many devices have a session open, or null while remote access is not running. */
  connectedDevices(): number | null {
    return this.remoteStatus?.online.length ?? null
  }

  /** The paired devices, as the remote host last reported them. */
  devices(): DeviceSummary[] {
    const status = this.remoteStatus
    if (!status) throw new ControlError('unavailable', 'Remote access is not running')
    return status.devices.map((device) => ({
      id: device.id,
      name: device.name,
      kind: device.kind,
      platform: device.platform,
      connected: status.online.includes(device.id),
      lastConnectedAt: device.lastConnectedAt,
    }))
  }

  /** Forgets a device and closes its sessions, settled once the remote host reports it gone. */
  async removeDevice(id: string): Promise<void> {
    if (!this.devices().some((device) => device.id === id)) {
      throw new ControlError('not_found', `No device ${id} is paired with this computer`)
    }
    const gone = (): boolean =>
      this.remoteStatus !== null && !this.remoteStatus.devices.some((device) => device.id === id)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => settle(new ControlError('unavailable', 'The remote host did not report it removed')),
        REMOVE_TIMEOUT_MS,
      )
      const listener = (): void => {
        if (gone()) settle(null)
        else if (!this.remoteStatus)
          settle(new ControlError('unavailable', 'Remote access stopped'))
      }
      const settle = (error: Error | null): void => {
        clearTimeout(timer)
        this.statusListeners.delete(listener)
        if (error) reject(error)
        else resolve()
      }
      this.statusListeners.add(listener)
      if (!this.remote.post({ type: 'remote-host:remove-device', id })) {
        settle(new ControlError('unavailable', 'Remote access is not running'))
      }
    })
  }

  /**
   * Opens a pairing code, voiding any other; `listener` hears its progress until it is added or
   * void. Throws while remote access is not running.
   */
  pair(listener: (pairing: PairingState) => void): number {
    const codeId = this.nextCode++
    if (!this.remoteStatus || !this.remote.post({ type: 'remote-host:pair', codeId })) {
      throw new ControlError('unavailable', 'Remote access is not running')
    }
    this.askers.set(codeId, listener)
    return codeId
  }

  /** The asker went, which voids its code. */
  closePairing(codeId: number): void {
    if (this.askers.delete(codeId)) this.remote.post({ type: 'remote-host:pair-close', codeId })
  }

  /** The answer to the device the code's asker was asked about. */
  answerPairing(codeId: number, add: boolean, name: string): void {
    if (!this.askers.has(codeId)) throw new ControlError('not_found', 'The code is not open')
    this.remote.post({ type: 'remote-host:pair-answer', codeId, add, name })
  }

  /** Direct connections as the remote host last reported them, or null while it is not running. */
  directStatus(): DirectStatus | null {
    return this.remoteStatus?.direct ?? null
  }

  /** Passes the direct connections' settings on when they changed; each start reads them anew. */
  directChanged(): void {
    const { direct } = this.settings().remote
    const sent = JSON.stringify(direct)
    if (sent === this.sentDirect) return
    if (this.remote.post({ type: 'remote-host:direct', direct })) this.sentDirect = sent
  }

  /** Passes the same settings on again, so a port that could not be opened is tried again. */
  retryDirect(): void {
    const { direct } = this.settings().remote
    if (this.remote.post({ type: 'remote-host:direct', direct })) {
      this.sentDirect = JSON.stringify(direct)
    }
  }

  /**
   * Settles once the remote host reports direct connections other than `before`, or stops, or
   * after a while when they stay as they were, as when a port tried again fails the same way.
   */
  directSettled(before: DirectStatus | null): Promise<void> {
    const was = JSON.stringify(before)
    const settled = (): boolean =>
      !this.remoteStatus || JSON.stringify(this.remoteStatus.direct) !== was
    if (settled()) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(() => done(), DIRECT_WAIT_MS)
      const listener = (): void => {
        if (settled()) done()
      }
      const done = (): void => {
        clearTimeout(timer)
        this.statusListeners.delete(listener)
        resolve()
      }
      this.statusListeners.add(listener)
    })
  }

  private initDirect(): DirectSettings {
    const { direct } = this.settings().remote
    this.sentDirect = JSON.stringify(direct)
    return direct
  }

  /** The remote host went, and every code with it. */
  private voidCodes(): void {
    const askers = [...this.askers.values()]
    this.askers.clear()
    for (const listener of askers) listener({ state: 'void', reason: 'stopped' })
  }

  /** Stops the hosts as main does when the app quits: devices hear why before the agent host goes. */
  async stop(): Promise<void> {
    await Promise.all([this.remote.stop().then(() => this.agent.stop()), this.terminal.stop()])
  }

  private setRemoteStatus(status: RemoteHostStatus | null): void {
    this.remoteStatus = status
    for (const listener of [...this.statusListeners]) listener()
  }

  private receiveRemote(message: RemoteHostToMain): void {
    switch (message.type) {
      case 'remote-host:status':
        if (isRemoteStatus(message.status)) this.setRemoteStatus(message.status)
        break
      case 'remote-host:pairing': {
        const listener = this.askers.get(message.codeId)
        if (!listener || !isPairingState(message.pairing)) break
        // A code ends once added or void; a new one has an id of its own.
        if (message.pairing.state === 'added' || message.pairing.state === 'void') {
          this.askers.delete(message.codeId)
        }
        listener(message.pairing)
        break
      }
      // Under Node.js the remote host connects to the agent host's socket itself, so a request
      // for a port gets the answer that none comes.
      case 'remote-host:open-port':
        if (Number.isSafeInteger(message.requestId)) {
          this.remote.post({ type: 'remote-host:port', requestId: message.requestId })
        }
        break
      case 'remote-host:log': {
        const text = typeof message.message === 'string' ? message.message : ''
        if (message.level === 'error') log.error(text)
        else if (message.level === 'warn') log.warn(text)
        else log.info(text)
        break
      }
      default:
        log.warn(`Ignored unknown message "${(message as { type: string }).type}"`)
    }
  }

  private receive(message: HostToMain): void {
    switch (message.type) {
      case 'host:agent-processes':
        if (Array.isArray(message.processes)) {
          this.agentProcesses = message.processes.flatMap((entry) =>
            Number.isSafeInteger(entry?.pid) && entry.pid > 1 && Number.isFinite(entry.startedAt)
              ? [{ pid: entry.pid, startedAt: entry.startedAt }]
              : [],
          )
        }
        break
      case 'host:projects':
        if (isStringList(message.paths)) {
          this.projects = message.paths
          this.terminal.post({ type: 'terminal-host:projects', paths: message.paths })
        }
        break
      case 'host:auth-commands':
        if (isStringList(message.commands)) {
          this.authCommands = message.commands
          this.terminal.post({ type: 'terminal-host:auth-commands', commands: message.commands })
        }
        break
      case 'host:browser-call':
        if (Number.isSafeInteger(message.callId)) {
          this.agent.post({
            type: 'browser-result',
            callId: message.callId,
            error: { code: 'no_page', message: 'This host drives no browser.' },
          })
        }
        break
      case 'host:log': {
        const text = typeof message.message === 'string' ? message.message : ''
        if (message.level === 'error') log.error(text)
        else if (message.level === 'warn') log.warn(text)
        else log.info(text)
        break
      }
      // The app's notifications, badge, tray, power saving, media and artifacts; the answers to
      // requests only main sends.
      case 'host:attention':
      case 'host:badge':
      case 'host:busy-changed':
      case 'host:routines-working':
      case 'host:media-grant':
      case 'host:media-revoke':
      case 'host:service-port':
      case 'host:busy':
      case 'host:granted':
      case 'host:artifact-content':
      case 'host:artifact-list':
      case 'host:artifact-import':
        break
      default:
        log.warn(`Ignored unknown message "${(message as { type: string }).type}"`)
    }
  }

  private agentExited(clean: boolean): void {
    const roots = this.agentProcesses
    this.agentProcesses = []
    // After a clean stop the host has stopped every agent itself.
    if (clean || roots.length === 0) return
    log.warn(`Stopping ${roots.length} agent process tree(s) left by the agent host`)
    const seenAt = Date.now()
    const trees = roots.map((root) => ({ ...root, seenAt }))
    stopTrees(processControl(process.platform), trees, GRACE_MS).then(
      ({ failures }) => {
        for (const { target, error } of failures) log.warn(`Could not stop ${target}: ${error}`)
      },
      (error: unknown) => log.warn(`Could not stop the agents: ${(error as Error).message}`),
    )
  }
}
