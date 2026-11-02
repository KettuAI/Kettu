// The daemon's side of the hosts, as main's AgentHost, TerminalHost and RemoteHost are the app's:
// their init, what they ask of main, and what is left after a crash. The daemon has no windows,
// notifications, tray or browser, so what serves those is not answered; remote access is always on,
// and so are its direct connections.

import path from 'node:path'
import type {
  AdminAnswer,
  DirectStatus,
  HostToMain,
  MainToHost,
  MainToRemoteHost,
  MainToTerminalHost,
  RemoteHostStatus,
  RemoteHostToMain,
  TerminalHostToMain,
} from '@shared/host-control'
import { BROWSER_UNAVAILABLE } from '@shared/browser'
import type { Locale } from '@shared/locale'
import type { DeviceActivity } from '@shared/remote/activity'
import { isDirectStatus, isPort } from '@shared/remote/address'
import { deviceId, type NewDevice } from '@shared/remote/device'
import type { HostAdminEvent } from '@shared/remote/host-admin'
import { isPairingState, type PairingState } from '@shared/remote/pairing'
import type { RemoteStatus } from '@shared/remote/status'
import type { DirectSettings, SettingsFile } from '@shared/settings'
import { processControl, stopTrees, type ProcessId } from '../agent-host/process-tree'
import { createLogger } from '../main/log'
import {
  hostSettings,
  reachesHost,
  terminalSettings,
  type SettingsSection,
} from '../main/settings-schema'
import { ControlError, type DeviceSummary, type HostName, type HostStatus } from './control'
import { ForkedHost, type HostTimings } from './forked-host'

type Attention = Extract<HostToMain, { type: 'host:attention' }>

const log = createLogger('daemon')
// What each host logs carries its own name, as in the app's log.
const agentLog = createLogger('agent-host')
const remoteLog = createLogger('remote-host')

const MAX_LIST = 10_000
const MAX_STRING = 8192
const MAX_DEVICES = 1000
/** How long an agent's tree gets between SIGTERM and SIGKILL after its host died, as in main. */
const GRACE_MS = 2_000
/** How long a removal waits for the remote host to report the device gone, or an addition added. */
const REMOVE_TIMEOUT_MS = 10_000
/** How long a change of the direct settings waits for the remote host to report what came of it. */
const DIRECT_WAIT_MS = 2_000
/** How long a request to the remote host may take before it is answered with nothing, as in main. */
const REQUEST_TIMEOUT_MS = 10_000
const MAX_ACTIVITY = 500

function isStringList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_LIST &&
    value.every((item) => typeof item === 'string' && item.length <= MAX_STRING)
  )
}

function isRemoteStatus(value: unknown): value is RemoteHostStatus {
  if (typeof value !== 'object' || value === null) return false
  const { publicKey, plainTextKey, devices, online, refused, direct, sshPort } = value as Record<
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
    isDirectStatus(direct) &&
    (sshPort === undefined || sshPort === null || isPort(sshPort))
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
  /** Replaces the host's identity with a new key, as resetting remote access does; its private key. */
  newIdentity(): Promise<string>
  /** The system's name for this computer, which devices show unless the owner names it. */
  hostName: string
  env: NodeJS.ProcessEnv
  timings?: HostTimings
  /** Answers an owner's call beyond its sessions, which a device made through the remote host. */
  admin?(deviceId: unknown, method: unknown, params: unknown): Promise<AdminAnswer>
  /** The port the last run took channels from SSH on, or null for any free one. */
  sshPort: number | null
  /** The remote host listens for SSH on another port, to keep for the next run. */
  sshPortChanged?(port: number): void
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
  private privateKey: string
  private resetting: Promise<void> | null = null
  private sshPort: number | null
  /** The direct settings the remote host was last given, as JSON. */
  private sentDirect: string | null = null
  /** Whether devices may use the terminal, as the remote host was last told. */
  private sentTerminal: boolean | null = null
  private sentHostName: string | null = null
  private readonly requests = new Map<number, (message: RemoteHostToMain | null) => void>()
  private nextRequest = 1
  private readonly settings: () => SettingsFile
  private readonly statusListeners = new Set<() => void>()
  private readonly attentionListeners = new Set<(message: Attention) => void>()
  private readonly askers = new Map<number, (pairing: PairingState) => void>()
  private nextCode = 1

  constructor(private readonly options: HostsOptions) {
    this.settings = options.settings
    this.privateKey = options.privateKey
    this.sshPort = options.sshPort
    const bundle = (name: string): string => path.join(options.bundleDir, name)
    this.agent = new ForkedHost<MainToHost, HostToMain>({
      log: agentLog,
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
      log: remoteLog,
      modulePath: bundle('remote-host.cjs'),
      socketName: null,
      env: options.env,
      timings: options.timings,
      initMessage: () => ({
        type: 'remote-host:init',
        userDataPath: options.dataPath,
        appVersion: options.version,
        platform: process.platform,
        hostName: this.initHostName(),
        privateKey: this.privateKey,
        plainTextKey: true,
        direct: this.initDirect(),
        // out/web, beside the daemon's build in out/daemon.
        webRoot: path.join(options.bundleDir, '../web'),
        terminal: this.initTerminal(),
        // The agent host's socket outlives its restarts, so a device's session finds it again.
        agentHostSocket: this.agent.socketPath ?? undefined,
        sshPort: this.sshPort,
      }),
      shutdownMessage: { type: 'remote-host:shutdown', reason: 'stopping' },
      readyType: 'remote-host:ready',
      stoppedType: 'remote-host:stopped',
      onMessage: (message) => this.receiveRemote(message),
      onExit: () => {
        this.setRemoteStatus(null)
        this.voidCodes()
        for (const answer of [...this.requests.values()]) answer(null)
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

  /** Remote access as Settings shows it, which is on while the remote host runs. */
  remoteAccess(): RemoteStatus {
    const status = this.remoteStatus
    return {
      state: status ? 'on' : this.remote.state === 'failed' ? 'failed' : 'starting',
      hostName: this.hostName(),
      systemName: this.options.hostName,
      devices: status?.devices ?? [],
      online: status?.online ?? [],
      plainTextKey: true,
      direct: status?.direct ?? { state: 'off' },
    }
  }

  /** Calls `listener` whenever the remote host reports, or goes; returns how to stop. */
  onRemoteChanged(listener: () => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  /** Calls `listener` with what the agent host says needs the user; returns how to stop. */
  onAttention(listener: (message: Attention) => void): () => void {
    this.attentionListeners.add(listener)
    return () => this.attentionListeners.delete(listener)
  }

  /** Renames a device, which its sessions hear; false when it is not paired or not running. */
  renameDevice(id: string, name: string): boolean {
    if (!this.remoteStatus?.devices.some((device) => device.id === id)) return false
    return this.remote.post({ type: 'remote-host:rename-device', id, name })
  }

  /**
   * Removes every device, telling each, and gives the host a new identity, which the remote host
   * restarts on, so every device has to pair again, as main's reset. Rejects while remote access
   * is not running.
   */
  resetRemote(): Promise<void> {
    this.resetting ??= this.reset().finally(() => (this.resetting = null))
    return this.resetting
  }

  private async reset(): Promise<void> {
    if (!this.remoteStatus) throw new ControlError('unavailable', 'Remote access is not running')
    const answer = await this.request((requestId) => ({ type: 'remote-host:reset', requestId }))
    if (answer?.type !== 'remote-host:reset') {
      throw new ControlError('unavailable', 'The remote host did not reset')
    }
    this.privateKey = await this.options.newIdentity()
    log.info('Reset remote access to a new identity')
    await this.remote.renew()
  }

  /** A device's activity, newest first; none when it cannot be read. */
  async activity(id: string): Promise<DeviceActivity[]> {
    const answer = await this.request((requestId) => ({
      type: 'remote-host:activity',
      requestId,
      id,
    }))
    if (answer?.type !== 'remote-host:activity' || !Array.isArray(answer.events)) return []
    return answer.events.slice(0, MAX_ACTIVITY)
  }

  /** Starts the agent or terminal host again once it failed; false in any other state. */
  restart(name: HostName): boolean {
    return (name === 'agent' ? this.agent : this.terminal).restart()
  }

  /** Tells the owner's devices something of the host: every one, or only `deviceId`. */
  adminEvent(event: HostAdminEvent, deviceId: string | null): void {
    this.remote.post({ type: 'remote-host:admin-event', event, deviceId })
  }

  /** Passes a change of the settings to the hosts that read it, as main does. */
  settingsChanged(changed: ReadonlySet<SettingsSection>): void {
    const settings = this.settings()
    // The agent host reads `general.sessionTitles` and the language, which `reachesHost` leaves.
    if (reachesHost(changed) || changed.has('general')) {
      this.agent.post({
        type: 'host:settings',
        settings: hostSettings(settings, this.options.systemLocale),
      })
    }
    if (changed.has('remote')) {
      this.directChanged()
      this.terminalChanged()
      const name = this.hostName()
      if (name !== this.sentHostName && this.remote.post({ type: 'remote-host:host-name', name })) {
        this.sentHostName = name
      }
    }
    // After the remote host, so devices hear why their terminals close.
    if (changed.has('terminal') || changed.has('remote')) {
      this.terminal.post({ type: 'terminal-host:settings', settings: terminalSettings(settings) })
    }
  }

  /**
   * Adds a device whose key came over an SSH login, which proves it is the owner's, settled once
   * the remote host reports it added.
   */
  async addDevice(device: NewDevice): Promise<void> {
    const id = await deviceId(Buffer.from(device.publicKey, 'base64'))
    await this.untilRemote(
      () => this.remoteStatus?.devices.some((paired) => paired.id === id) === true,
      () => this.remote.post({ type: 'remote-host:add-device', device }),
      'The remote host did not report it added',
    )
  }

  /** What a computer adding this one over SSH connects with; throws while it cannot. */
  sshInfo(): { publicKey: string; port: number } {
    const status = this.remoteStatus
    if (!status) throw new ControlError('unavailable', 'Remote access is not running')
    if (status.sshPort === undefined || status.sshPort === null) {
      throw new ControlError('unavailable', 'Channels through SSH cannot listen on this computer')
    }
    return { publicKey: status.publicKey, port: status.sshPort }
  }

  /**
   * Posts what `post` sends and settles once a report makes `done` true; rejects when the remote
   * host does not run, stops or does not report it in time.
   */
  private untilRemote(done: () => boolean, post: () => boolean, late: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => settle(new ControlError('unavailable', late)),
        REMOVE_TIMEOUT_MS,
      )
      const listener = (): void => {
        if (done()) settle(null)
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
      if (!this.remoteStatus || !post()) {
        settle(new ControlError('unavailable', 'Remote access is not running'))
      }
    })
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

  /** Tells the remote host when devices may use the terminal or no longer may; each start reads it. */
  private terminalChanged(): void {
    const allowed = this.settings().remote.terminal
    if (allowed === this.sentTerminal) return
    if (this.remote.post({ type: 'remote-host:terminal', allowed })) this.sentTerminal = allowed
  }

  /** The name devices show for this computer: the owner's, or the system's. */
  private hostName(): string {
    return this.settings().remote.name ?? this.options.hostName
  }

  private initHostName(): string {
    this.sentHostName = this.hostName()
    return this.sentHostName
  }

  private request(
    message: (requestId: number) => MainToRemoteHost,
  ): Promise<RemoteHostToMain | null> {
    const requestId = this.nextRequest++
    return new Promise((resolve) => {
      const timer = setTimeout(() => answer(null), REQUEST_TIMEOUT_MS)
      const answer = (reply: RemoteHostToMain | null): void => {
        clearTimeout(timer)
        this.requests.delete(requestId)
        resolve(reply)
      }
      this.requests.set(requestId, answer)
      if (!this.remote.post(message(requestId))) answer(null)
    })
  }

  /** Answers an owner's call under its id. */
  private async answerAdmin(
    message: Extract<RemoteHostToMain, { type: 'remote-host:admin-call' }>,
  ): Promise<void> {
    const { requestId, deviceId, method, params } = message
    if (!Number.isSafeInteger(requestId)) return
    const answer: AdminAnswer = this.options.admin
      ? await this.options.admin(deviceId, method, params)
      : { error: { code: 'unavailable', message: 'This host takes no such calls' } }
    this.remote.post({ type: 'remote-host:admin-result', requestId, ...answer })
  }

  private initTerminal(): boolean {
    this.sentTerminal = this.settings().remote.terminal
    return this.sentTerminal
  }

  /** The terminal host's socket for a device's terminals, starting it; none while not allowed. */
  private async openTerminal(requestId: number): Promise<void> {
    let socketPath: string | null = null
    if (this.settings().remote.terminal) {
      try {
        await this.terminal.ready()
        // Checked again, since it may have been turned off while the terminal host started.
        if (this.settings().remote.terminal) socketPath = this.terminal.socketPath
      } catch (error) {
        log.warn(
          `A device's terminal cannot open: the terminal host is ${(error as Error).message}`,
        )
      }
    }
    this.remote.post({ type: 'remote-host:terminal-socket', requestId, socketPath })
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

  /** Keeps the port the remote host listens for SSH on, so its next start takes it again. */
  private keepSshPort(port: number | null | undefined): void {
    if (typeof port !== 'number' || port === this.sshPort) return
    this.sshPort = port
    this.options.sshPortChanged?.(port)
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
        if (!isRemoteStatus(message.status)) break
        this.keepSshPort(message.status.sshPort)
        this.setRemoteStatus(message.status)
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
      // The terminal host starts on the first device that asks, so its socket is named then.
      case 'remote-host:open-terminal-port':
        if (Number.isSafeInteger(message.requestId)) void this.openTerminal(message.requestId)
        break
      case 'remote-host:activity':
      case 'remote-host:reset':
        this.requests.get(message.requestId)?.(message)
        break
      case 'remote-host:admin-call':
        void this.answerAdmin(message)
        break
      case 'remote-host:log': {
        const text = typeof message.message === 'string' ? message.message : ''
        if (message.level === 'error') remoteLog.error(text)
        else if (message.level === 'warn') remoteLog.warn(text)
        else remoteLog.info(text)
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
            error: { code: 'unavailable', message: BROWSER_UNAVAILABLE },
          })
        }
        break
      case 'host:log': {
        const text = typeof message.message === 'string' ? message.message : ''
        if (message.level === 'error') agentLog.error(text)
        else if (message.level === 'warn') agentLog.warn(text)
        else agentLog.info(text)
        break
      }
      case 'host:attention':
        for (const listener of this.attentionListeners) listener(message)
        break
      // The app's badge, tray, power saving, media and artifacts; the answers to requests only
      // main sends.
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
