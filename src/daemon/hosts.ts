// The daemon's side of the hosts, as main's AgentHost, TerminalHost and RemoteHost are the app's:
// their init, what they ask of main, and what is left after a crash. The daemon has no windows,
// notifications, tray or browser, so what serves those is not answered; remote access is always on,
// and so are its direct connections.

import type { DeviceCall } from '@shared/device-agent'
import type { TerminalCall } from '@shared/terminal-agent'
import path from 'node:path'
import type {
  AdminAnswer,
  DirectStatus,
  HostToMain,
  MainToHost,
  MainToRemoteHost,
  MainToTerminalHost,
  MainToDeviceHost,
  DeviceHostToMain,
  OwnRelayInit,
  RelayInit,
  RemoteHostStatus,
  RemoteHostToMain,
  SettingsCallAnswer,
  TerminalHostToMain,
} from '@shared/host-control'
import { pushedAttention } from '@shared/attention'
import { BROWSER_UNAVAILABLE } from '@shared/browser'
import { resolveLocale, type Locale } from '@shared/locale'
import type { DeviceActivity } from '@shared/remote/activity'
import { isDirectStatus, isPort } from '@shared/remote/address'
import { deviceId, type NewDevice } from '@shared/remote/device'
import type { HostAdminEvent } from '@shared/remote/host-admin'
import { isPairingState, type PairingState } from '@shared/remote/pairing'
import { parseRelayStatuses } from '@shared/remote/relay-host'
import { relayReport, type RelayReport, type RemoteStatus } from '@shared/remote/status'
import { accessKeyEnd, relayChoiceInit } from '@shared/remote/own-relay'
import type { MarketAccount, MarketCall, MarketCallAnswer } from '@shared/market-publish'
import { reportBuildResult, type ReportBuildResult } from '@shared/report'
import type { DirectSettings, SettingsFile } from '@shared/settings'
import { processControl, stopTrees, type ProcessId } from '../agent-host/process-tree'
import { t } from '../main/i18n'
import { createLogger } from '../main/log'
import { marketCallOf } from '../main/market-api'
import type { MarketKeysPush } from '../main/market-keys'
import {
  hostSettings,
  reachesHost,
  terminalSettings,
  type SettingsSection,
} from '../main/settings-schema'
import { ControlError, type DeviceSummary, type HostName, type HostStatus } from './control'
import { PluginHost } from './plugin-host'
import { ForkedHost, type HostTimings } from './forked-host'
import { daemonUserAgent } from './update'

type Attention = Extract<HostToMain, { type: 'host:attention' }>
type ReportParams = Omit<Extract<MainToHost, { type: 'host:report-request' }>, 'type' | 'requestId'>

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
/** How long the agent host may take to build a problem report, as in main. */
const REPORT_TIMEOUT_MS = 120_000

function isStringList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_LIST &&
    value.every((item) => typeof item === 'string' && item.length <= MAX_STRING)
  )
}

function isRemoteStatus(value: unknown): value is RemoteHostStatus {
  if (typeof value !== 'object' || value === null) return false
  const { publicKey, plainTextKey, devices, online, refused, direct, sshPort, relays } =
    value as Record<string, unknown>
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
    (sshPort === undefined || sshPort === null || isPort(sshPort)) &&
    parseRelayStatuses(relays) !== null
  )
}

export interface HostsOptions {
  /** The folder of the daemon's build, which holds each host's bundle. */
  bundleDir: string
  dataPath: string
  version: string
  systemLocale: Locale
  settings(): SettingsFile
  /** The Marketplace's key store, values and OAuth sign-ins, which follows the agent host's init. */
  marketKeys(): MarketKeysPush
  /** The agent host asks to keep or clear a server's OAuth sign-in, checked against the settings. */
  marketOAuth?(serverId: unknown, state: unknown): void
  /** The Kettu account the Marketplace tools publish with, which follows the agent host's init. */
  marketAccount(): MarketAccount | null
  /** Makes a Marketplace API call of the agent host's with the account's access token. */
  marketCall?(call: MarketCall): Promise<MarketCallAnswer>
  /** An agent's settings tool reads or changes the daemon's settings. */
  settingsCall?(call: unknown): SettingsCallAnswer
  /** Keeps a plugin's secret in the key store, or clears it; null once the store holds it. */
  pluginSecret?(pluginId: unknown, key: unknown, value: unknown): Promise<string | null>
  /** The agent host's first start found the programs of these harnesses; the daemon adds their agents. */
  firstStart?(harnesses: unknown): void
  /** The themes plugins bring changed, so the daemon reads them again. */
  pluginThemes?(): void
  /** The host's X25519 private key, in base64, for the remote host alone. */
  privateKey: string
  /** Replaces the host's identity with a new key, as resetting remote access does; its private key. */
  newIdentity(): Promise<string>
  /** The Ed25519 seed the host signs in to the relay with, in base64; null without one. */
  relayKey: string | null
  /** The own relay's access key now, null for none. */
  accessKey(): string | null
  /** Replaces the relay key, as resetting remote access does; its seed. */
  newRelayKey(): Promise<string>
  /** The main relay's origin. */
  relayUrl: string
  /** The push gateway's origin. */
  pushUrl: string
  /** Whether the daemon is signed in to a Kettu account now. */
  signedIn(): boolean
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
  /** A host's inspector in a debug run, by its name, or null once the host is gone. */
  inspector?(name: string, url: string | null): void
}

type AnyHost = ForkedHost<unknown, { type: string }>

export class Hosts {
  private readonly agent: ForkedHost<MainToHost, HostToMain>
  private readonly terminal: ForkedHost<MainToTerminalHost, TerminalHostToMain>
  private readonly deviceHost: ForkedHost<MainToDeviceHost, DeviceHostToMain>
  private readonly remote: ForkedHost<MainToRemoteHost, RemoteHostToMain>
  private readonly pluginHost: PluginHost
  private projects: string[] = []
  private authCommands: string[] = []
  private agentProcesses: ProcessId[] = []
  private remoteStatus: RemoteHostStatus | null = null
  private privateKey: string
  private relayKey: string | null
  /** The account's access token, as the remote host was last given it. */
  private token: string | null = null
  /** The relay token the relays get in its place, once the main relay takes them. */
  private relayToken: string | null = null
  /** The language the hosts were last told, for the text they write. */
  private sentLocale: Locale
  /** The relay, as the remote host was last told, in JSON. */
  private sentRelay: string | null = null
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
  /** What waits for the user by session, which each remote host process starts with. */
  private waiting: Record<string, string[]> = {}
  private readonly askers = new Map<number, (pairing: PairingState) => void>()
  private nextCode = 1
  private readonly reportRequests = new Map<number, (result: ReportBuildResult) => void>()
  private nextReport = 1
  /** The agent host's log level since detailed records last changed; a restart takes it again. */
  private logLevel: { level: 'debug' | 'info'; verbose: boolean } | null = null

  constructor(private readonly options: HostsOptions) {
    this.settings = options.settings
    this.privateKey = options.privateKey
    this.relayKey = options.relayKey
    this.sshPort = options.sshPort
    this.sentLocale = this.locale()
    const bundle = (name: string): string => path.join(options.bundleDir, name)
    this.agent = new ForkedHost<MainToHost, HostToMain>({
      log: agentLog,
      modulePath: bundle('agent-host.cjs'),
      socketName: 'agent-host',
      env: options.env,
      inspector: (url) => options.inspector?.('agent-host', url),
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
        clineHostPath: bundle('cline-host.cjs'),
        settings: hostSettings(options.settings(), options.systemLocale),
        socketPath: socketPath ?? undefined,
        userAgent: daemonUserAgent(options.version, process.platform, process.arch),
      }),
      startMessages: () => [
        { type: 'host:market-keys', ...options.marketKeys() },
        { type: 'host:market-account', account: options.marketAccount() },
      ],
      shutdownMessage: { type: 'host:shutdown' },
      readyType: 'host:ready',
      stoppedType: 'host:stopped',
      onReady: () => {
        if (this.logLevel) this.agent.post({ type: 'host:log-level', ...this.logLevel })
      },
      onMessage: (message) => this.receive(message),
      onExit: (clean) => this.agentExited(clean),
    })
    this.terminal = new ForkedHost<MainToTerminalHost, TerminalHostToMain>({
      log: createLogger('terminal-host'),
      modulePath: bundle('terminal-host.cjs'),
      socketName: 'terminal-host',
      env: options.env,
      inspector: (url) => options.inspector?.('terminal-host', url),
      timings: options.timings,
      initMessage: (socketPath) => ({
        type: 'terminal-host:init',
        platform: process.platform,
        appVersion: options.version,
        locale: this.locale(),
        settings: terminalSettings(options.settings()),
        projects: this.projects,
        authCommands: this.authCommands,
        socketPath: socketPath ?? undefined,
      }),
      shutdownMessage: { type: 'terminal-host:shutdown' },
      readyType: 'terminal-host:ready',
      stoppedType: 'terminal-host:stopped',
      onMessage: (message) => {
        if (message.type === 'terminal-host:answer') {
          this.agent.post({
            type: 'terminal-result',
            callId: message.callId,
            answer: message.answer,
          })
        } else if (message.type === 'terminal-host:handed-back') {
          const { sessionId, durationMs } = message
          if (
            typeof sessionId === 'string' &&
            Number.isSafeInteger(durationMs) &&
            durationMs >= 0
          ) {
            this.agent.post({ type: 'host:terminal-handed-back', sessionId, durationMs })
          }
        } else {
          log.warn(`Ignored terminal host message "${message.type}"`)
        }
      },
    })
    // Mobile devices: started by the first agent call or paired device that needs one.
    this.deviceHost = new ForkedHost<MainToDeviceHost, DeviceHostToMain>({
      log: createLogger('device-host'),
      modulePath: bundle('device-host.cjs'),
      socketName: 'device-host',
      env: options.env,
      inspector: (url) => options.inspector?.('device-host', url),
      timings: options.timings,
      initMessage: (socketPath) => ({
        type: 'device-host:init',
        platform: process.platform,
        appVersion: options.version,
        locale: this.locale(),
        nodeRuntime: { command: process.execPath, env: {} },
        dataDir: options.dataPath,
        resourcesPath: null,
        allowDevices: true,
        socketPath: socketPath ?? undefined,
      }),
      shutdownMessage: { type: 'device-host:shutdown' },
      readyType: 'device-host:ready',
      stoppedType: 'device-host:stopped',
      onMessage: (message) => {
        if (message.type === 'device-host:answer') {
          this.agent.post({ type: 'device-result', callId: message.callId, answer: message.answer })
        } else if (message.type === 'device-host:handed-back') {
          const { sessionId, durationMs } = message
          if (
            typeof sessionId === 'string' &&
            Number.isSafeInteger(durationMs) &&
            durationMs >= 0
          ) {
            this.agent.post({ type: 'host:device-handed-back', sessionId, durationMs })
          }
        }
      },
    })
    // Plugins' scripts: started when the agent host wakes the first one.
    this.pluginHost = new PluginHost({
      modulePath: bundle('plugin-host.cjs'),
      wasmPath: bundle('quickjs.wasm'),
      env: options.env,
      inspector: (url) => options.inspector?.('plugin-host', url),
      timings: options.timings,
      ready: (socketPath) => this.agent.post({ type: 'host:plugin-port', socketPath }),
    })
    // Devices reach it through its direct connections, as in the desktop app, not a socket.
    this.remote = new ForkedHost<MainToRemoteHost, RemoteHostToMain>({
      log: remoteLog,
      modulePath: bundle('remote-host.cjs'),
      socketName: null,
      env: options.env,
      inspector: (url) => options.inspector?.('remote-host', url),
      timings: options.timings,
      initMessage: () => ({
        type: 'remote-host:init',
        userDataPath: options.dataPath,
        appVersion: options.version,
        platform: process.platform,
        locale: this.locale(),
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
        relay: this.initRelay(),
        push: options.pushUrl,
        waiting: this.waiting,
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

  /** The language of the text the daemon and its hosts write, as its settings and system say. */
  private locale(): Locale {
    return resolveLocale(this.settings().general.language, this.options.systemLocale)
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
      service: true,
      direct: status?.direct ?? { state: 'off' },
      relay: this.relayReport(),
    }
  }

  /** The relay as Settings and `kettu status` show it. */
  relayReport(): RelayReport {
    const { relay, ownRelay } = this.settings().remote
    return relayReport({
      choice: relay,
      // The daemon has no switch for Kettu's services.
      cloud: true,
      signedIn: this.options.signedIn(),
      relays: this.remoteStatus?.relays ?? [],
      own: ownRelay,
      ownStatus: this.remoteStatus?.ownRelay ?? null,
      keyEnd: accessKeyEnd(this.options.accessKey()),
    })
  }

  /** The relay to sign in to, as the settings and the key are now. */
  private relayInit(): { enabled: boolean; own: OwnRelayInit | null } {
    return relayChoiceInit(this.settings().remote, true, this.options.accessKey())
  }

  /** Tells the remote host when the relay to use changed; each start reads it. */
  relayChanged(): void {
    const relay = this.relayInit()
    const sent = JSON.stringify(relay)
    if (sent === this.sentRelay) return
    if (this.remote.post({ type: 'remote-host:relay', enabled: relay.enabled, own: relay.own })) {
      this.sentRelay = sent
    }
    for (const listener of [...this.statusListeners]) listener()
  }

  /**
   * A fresh access token, or null once signed out, which closes every relay socket; with the relay
   * token the relays get in its place once the main relay takes them.
   */
  setToken(token: string | null, relay: string | null = null): void {
    if (token === this.token && relay === this.relayToken) return
    this.token = token
    this.relayToken = relay
    this.remote.post({ type: 'remote-host:token', token, relay })
    // Without a sign-in, direct connections are the devices' only way, and held on.
    this.directChanged()
  }

  /** Tries every relay now, after a conflict or an error. */
  retryRelay(): void {
    this.remote.post({ type: 'remote-host:relay-retry' })
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
    this.relayKey = await this.options.newRelayKey()
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

  /** The agent host's log level and detailed records, which a restart keeps. */
  setLogLevel(level: 'debug' | 'info', verbose: boolean): void {
    this.logLevel = { level, verbose }
    this.agent.post({ type: 'host:log-level', level, verbose })
  }

  /** Whether the agent host runs, to build a report with its sessions and agents. */
  agentReady(): boolean {
    return this.agent.state === 'ready'
  }

  /** A problem report's bundle, which the agent host writes into the data folder. */
  report(params: ReportParams): Promise<ReportBuildResult> {
    const down: ReportBuildResult = {
      ok: false,
      reason: 'failed',
      message: t('agentHost.down'),
    }
    if (this.agent.state !== 'ready') return Promise.resolve(down)
    const requestId = this.nextReport++
    return new Promise((resolve) => {
      const timer = setTimeout(() => answer(late), REPORT_TIMEOUT_MS)
      const late: ReportBuildResult = {
        ok: false,
        reason: 'failed',
        message: t('agentHost.silent'),
      }
      const answer = (result: ReportBuildResult): void => {
        clearTimeout(timer)
        this.reportRequests.delete(requestId)
        resolve(result)
      }
      this.reportRequests.set(requestId, answer)
      if (!this.agent.post({ type: 'host:report-request', requestId, ...params })) answer(down)
    })
  }

  /** Starts the agent or terminal host again once it failed; false in any other state. */
  restart(name: HostName): boolean {
    return (name === 'agent' ? this.agent : this.terminal).restart()
  }

  /** Tells the owner's devices something of the host: every one, or only `deviceId`. */
  adminEvent(event: HostAdminEvent, deviceId: string | null): void {
    this.remote.post({ type: 'remote-host:admin-event', event, deviceId })
  }

  /** The sign-in changed, so the Marketplace tools are listed or not. */
  marketAccountChanged(): void {
    this.agent.post({ type: 'host:market-account', account: this.options.marketAccount() })
  }

  /** The Marketplace's key store changed; all of it goes to the agent host. */
  marketKeysChanged(contents: MarketKeysPush): void {
    this.agent.post({ type: 'host:market-keys', ...contents })
  }

  /** Passes a change of the settings to the hosts that read it, as main does. */
  settingsChanged(changed: ReadonlySet<SettingsSection>): void {
    const settings = this.settings()
    // The agent host reads `general.sessionTitles`, `general.lightModel` and the language, which
    // `reachesHost` leaves.
    if (reachesHost(changed) || changed.has('general')) {
      this.agent.post({
        type: 'host:settings',
        settings: hostSettings(settings, this.options.systemLocale),
      })
    }
    // Hosts that are not running read it when they start.
    const locale = this.locale()
    if (locale !== this.sentLocale) {
      this.sentLocale = locale
      this.terminal.post({ type: 'terminal-host:locale', locale })
      this.deviceHost.post({ type: 'device-host:locale', locale })
      this.remote.post({ type: 'remote-host:locale', locale })
    }
    if (changed.has('remote')) {
      this.directChanged()
      this.terminalChanged()
      this.relayChanged()
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

  /** The direct connections as the remote host applies them, held on while the relay is not used. */
  private direct(): DirectSettings {
    const { direct, relay } = this.settings().remote
    const relayUsed = (relay === 'kettu' && this.options.signedIn()) || relay === 'own'
    return relayUsed ? direct : { ...direct, enabled: true }
  }

  /** Passes the direct connections' settings on when they changed; each start reads them anew. */
  directChanged(): void {
    const direct = this.direct()
    const sent = JSON.stringify(direct)
    if (sent === this.sentDirect) return
    if (this.remote.post({ type: 'remote-host:direct', direct })) this.sentDirect = sent
  }

  /** Passes the same settings on again, so a port that could not be opened is tried again. */
  retryDirect(): void {
    const direct = this.direct()
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
      : { error: { code: 'unavailable', message: t('remoteHost.noAdmin') } }
    this.remote.post({ type: 'remote-host:admin-result', requestId, ...answer })
  }

  private initTerminal(): boolean {
    this.sentTerminal = this.settings().remote.terminal
    return this.sentTerminal
  }

  /** Runs an agent's device call on the device host, starting it on the first one. */
  private async deviceCall(callId: number, call: DeviceCall): Promise<void> {
    try {
      await this.deviceHost.ready()
      if (this.deviceHost.post({ type: 'device-host:call', callId, call })) return
    } catch (error) {
      log.warn(`A device call cannot run: the device host is ${(error as Error).message}`)
    }
    this.agent.post({
      type: 'device-result',
      callId,
      answer: { error: { code: 'unavailable', message: t('deviceHost.notRunning') } },
    })
  }

  /** Makes the agent host's Marketplace call with the daemon's sign-in. */
  private async marketCall(callId: number, raw: unknown): Promise<void> {
    const call = marketCallOf(raw)
    const run = this.options.marketCall
    const answer: MarketCallAnswer =
      call && run
        ? await run(call)
        : {
            error: {
              code: call ? 'signed_out' : 'unavailable',
              status: null,
              message: call ? t('daemon.notSignedIn') : 'Not a Marketplace call.',
            },
          }
    this.agent.post({ type: 'market-result', callId, answer })
  }

  /** Runs an agent's terminal call on the terminal host, starting it on the first one. */
  private async terminalCall(callId: number, call: TerminalCall): Promise<void> {
    try {
      await this.terminal.ready()
      if (this.terminal.post({ type: 'terminal-host:call', callId, call })) return
    } catch (error) {
      log.warn(`A terminal call cannot run: the terminal host is ${(error as Error).message}`)
    }
    this.agent.post({
      type: 'terminal-result',
      callId,
      answer: { error: { code: 'unavailable', message: t('terminalHost.notRunning') } },
    })
  }

  /** The device host's socket for a paired device's mobile devices, starting it. */
  private async openDevices(requestId: number): Promise<void> {
    let socketPath: string | null = null
    try {
      await this.deviceHost.ready()
      socketPath = this.deviceHost.socketPath
    } catch (error) {
      log.warn(`A device's devices cannot open: the device host is ${(error as Error).message}`)
    }
    this.remote.post({ type: 'remote-host:device-socket', requestId, socketPath })
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
    const direct = this.direct()
    this.sentDirect = JSON.stringify(direct)
    return direct
  }

  private initRelay(): RelayInit {
    const relay = this.relayInit()
    this.sentRelay = JSON.stringify(relay)
    return {
      url: this.options.relayUrl,
      enabled: relay.enabled,
      own: relay.own,
      token: this.token,
      relayToken: this.relayToken,
      ...(this.relayKey ? { key: this.relayKey } : {}),
    }
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
    await Promise.all([
      this.remote.stop().then(() => this.agent.stop()),
      this.terminal.stop(),
      this.deviceHost.stop(),
      this.pluginHost.stop(),
    ])
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
      case 'remote-host:open-device-port':
        if (Number.isSafeInteger(message.requestId)) void this.openDevices(message.requestId)
        break
      case 'remote-host:activity':
      case 'remote-host:reset':
        this.requests.get(message.requestId)?.(message)
        break
      case 'remote-host:admin-call':
        void this.answerAdmin(message)
        break
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
      case 'host:market-oauth':
        this.options.marketOAuth?.(message.serverId, message.state)
        break
      case 'host:first-start':
        this.options.firstStart?.(message.harnesses)
        break
      case 'host:sessions-ended':
        if (isStringList(message.sessionIds)) {
          this.terminal.post({
            type: 'terminal-host:sessions-ended',
            sessionIds: message.sessionIds,
          })
          this.deviceHost.post({
            type: 'device-host:sessions-ended',
            sessionIds: message.sessionIds,
          })
        }
        break
      case 'host:plugin-host':
        this.pluginHost.setWanted(message.run === true)
        break
      case 'host:plugin-themes':
        this.options.pluginThemes?.()
        break
      case 'host:device-call':
        if (Number.isSafeInteger(message.callId) && typeof message.call === 'object') {
          void this.deviceCall(message.callId, message.call)
        }
        break
      case 'host:device-turn-ended':
        if (typeof message.sessionId === 'string') {
          this.deviceHost.post({ type: 'device-host:turn-ended', sessionId: message.sessionId })
        }
        break
      case 'host:terminal-call':
        if (Number.isSafeInteger(message.callId) && typeof message.call === 'object') {
          void this.terminalCall(message.callId, message.call)
        }
        break
      case 'host:terminal-turn-ended':
        if (typeof message.sessionId === 'string') {
          this.terminal.post({ type: 'terminal-host:turn-ended', sessionId: message.sessionId })
        }
        break
      case 'host:auth-commands':
        if (isStringList(message.commands)) {
          this.authCommands = message.commands
          this.terminal.post({ type: 'terminal-host:auth-commands', commands: message.commands })
        }
        break
      case 'host:market-call':
        if (Number.isSafeInteger(message.callId)) void this.marketCall(message.callId, message.call)
        break
      case 'host:settings-call':
        if (Number.isSafeInteger(message.callId)) {
          const run = this.options.settingsCall
          this.agent.post({
            type: 'settings-result',
            callId: message.callId,
            answer: run ? run(message.call) : { error: 'The daemon keeps no settings for agents.' },
          })
        }
        break
      case 'host:plugin-secret':
        if (Number.isSafeInteger(message.callId)) {
          const { callId } = message
          const run = this.options.pluginSecret
          void (
            run
              ? run(message.pluginId, message.key, message.value)
              : Promise.resolve('The daemon keeps no secrets for plugins.')
          ).then((error) => this.agent.post({ type: 'plugin-secret-result', callId, error }))
        }
        break
      case 'host:trash-call':
        if (Number.isSafeInteger(message.callId)) {
          // Under Node.js the host reaches no system trash, so a delete there asks to remove for good.
          this.agent.post({
            type: 'trash-result',
            callId: message.callId,
            error: t('daemon.noTrash'),
          })
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
      case 'host:attention': {
        for (const listener of this.attentionListeners) listener(message)
        const attention = pushedAttention(message)
        if (attention) this.remote.post({ type: 'remote-host:attention', attention })
        break
      }
      case 'host:waiting':
        if (typeof message.sessions === 'object' && message.sessions !== null) {
          this.waiting = message.sessions
          this.remote.post({ type: 'remote-host:waiting', sessions: message.sessions })
        }
        break
      case 'host:seen':
        if (typeof message.sessionId === 'string') {
          this.remote.post({ type: 'remote-host:seen', sessionId: message.sessionId })
        }
        break
      case 'host:report':
        this.reportRequests.get(message.requestId)?.(reportBuildResult(message.result))
        break
      // The app's badge, tray, power saving, media and artifacts; the answers to requests only
      // main sends.
      case 'host:badge':
      case 'host:busy-changed':
      case 'host:routines-working':
      case 'host:media-grant':
      case 'host:media-revoke':
      case 'host:service-port':
      case 'host:browser-origin-decide':
      case 'host:browser-turn-ended':
      case 'host:browser-ask-answer':
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
    // The plugins it woke are gone with it; its next process asks again.
    this.pluginHost.setWanted(false)
    // No turn of the agent host runs now, so none uses a device or a terminal.
    this.deviceHost.post({ type: 'device-host:turn-ended', sessionId: null })
    this.terminal.post({ type: 'terminal-host:turn-ended', sessionId: null })
    for (const answer of [...this.reportRequests.values()]) {
      answer({ ok: false, reason: 'failed', message: t('agentHost.exited') })
    }
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
