import { app, MessageChannelMain, type MessagePortMain, type WebContents } from 'electron'
import type { BusyTerminal, MainToTerminalHost, TerminalHostToMain } from '@shared/host-control'
import type { PortDevice } from '@shared/remote/device'
import type { TerminalSettings } from '@shared/settings'
import {
  TERMINAL_CALL_TIMEOUT_MS,
  type TerminalCall,
  type TerminalCallAnswer,
} from '@shared/terminal-agent'
import terminalHostPath from '../terminal-host/index?modulePath'
import { locale as currentLocale, t } from './i18n'
import { createLogger } from './log'
import { UtilityHost, type UtilityHostEvent, type UtilityHostState } from './utility-host'

const log = createLogger('terminal-host')

export interface TerminalHostDeps {
  settings(): TerminalSettings
  onReady?(): void
  /** The user handed back a terminal an agent's turn uses, after holding it for `durationMs`. */
  onHandedBack?(sessionId: string, durationMs: number): void
}

function isBusyTerminal(value: unknown): value is BusyTerminal {
  if (typeof value !== 'object' || value === null) return false
  const { id, projectPath, title } = value as Record<string, unknown>
  return typeof id === 'string' && typeof projectPath === 'string' && typeof title === 'string'
}

/** Main's side of the terminal host, which starts on the first window's or device's port. */
export class TerminalHost {
  private readonly host: UtilityHost<MainToTerminalHost, TerminalHostToMain>
  private projects: string[] = []
  private authCommands: string[] = []
  private readonly busyRequests = new Map<number, (terminals: BusyTerminal[]) => void>()
  private nextBusyId = 1
  private readonly calls = new Map<number, (answer: TerminalCallAnswer) => void>()
  private readonly pending: { callId: number; call: TerminalCall }[] = []
  private nextCall = 1

  constructor(deps: TerminalHostDeps) {
    this.host = new UtilityHost<MainToTerminalHost, TerminalHostToMain>({
      label: 'terminal-host',
      channel: 'terminal-host',
      modulePath: terminalHostPath,
      serviceName: 'Kettu Terminal Host',
      initMessage: () => ({
        type: 'terminal-host:init',
        platform: process.platform,
        appVersion: app.getVersion(),
        locale: currentLocale(),
        settings: deps.settings(),
        projects: this.projects,
        authCommands: this.authCommands,
      }),
      connectMessage: (windowId) => ({ type: 'terminal-host:connect', windowId }),
      shutdownMessage: { type: 'terminal-host:shutdown' },
      readyType: 'terminal-host:ready',
      stoppedType: 'terminal-host:stopped',
      onMessage: (message) => this.receive(message, deps),
      onReady: () => {
        this.flushPending()
        deps.onReady?.()
      },
      onExit: () => {
        for (const resolve of this.busyRequests.values()) resolve([])
        this.busyRequests.clear()
        for (const resolve of this.calls.values()) {
          resolve({ error: { code: 'unavailable', message: t('terminalHost.stopped') } })
        }
        this.calls.clear()
        this.pending.length = 0
      },
    })
  }

  get state(): UtilityHostState {
    return this.host.state
  }

  /** Whether it may hold terminals: started and not stopped or crashed since. */
  get running(): boolean {
    return this.host.state === 'starting' || this.host.state === 'ready'
  }

  history(): UtilityHostEvent[] {
    return this.host.history()
  }

  connect(webContents: WebContents): void {
    this.host.connect(webContents)
  }

  revoke(webContents: WebContents): void {
    this.host.revoke(webContents)
  }

  /**
   * A port for a paired device's terminals, starting the host if it has not run yet; null while it
   * cannot run.
   */
  connectDevice(device: PortDevice): MessagePortMain | null {
    this.host.start()
    const { port1, port2 } = new MessageChannelMain()
    if (this.host.post({ type: 'terminal-host:connect', windowId: -1, device }, [port1])) {
      return port2
    }
    port1.close()
    port2.close()
    return null
  }

  restart(): void {
    this.host.restart()
  }

  pushSettings(settings: TerminalSettings): void {
    this.host.post({ type: 'terminal-host:settings', settings })
  }

  /** Tells the process the interface language changed, for the text it writes. */
  localeChanged(): void {
    this.host.post({ type: 'terminal-host:locale', locale: currentLocale() })
  }

  setProjects(paths: string[]): void {
    this.projects = paths
    this.host.post({ type: 'terminal-host:projects', paths })
  }

  endSessions(sessionIds: string[]): void {
    this.host.post({ type: 'terminal-host:sessions-ended', sessionIds })
  }

  setAuthCommands(commands: string[]): void {
    this.authCommands = commands
    this.host.post({ type: 'terminal-host:auth-commands', commands })
  }

  /** The turn of a session whose agent used a terminal ended; null: every turn of the host. */
  turnEnded(sessionId: string | null): void {
    this.host.post({ type: 'terminal-host:turn-ended', sessionId })
  }

  /** Runs an agent's terminal call, starting the host when it is not running. */
  call(call: TerminalCall): Promise<TerminalCallAnswer> {
    this.host.start()
    const callId = this.nextCall++
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.calls.delete(callId)
        resolve({ error: { code: 'failed', message: t('terminalHost.silent') } })
      }, TERMINAL_CALL_TIMEOUT_MS)
      this.calls.set(callId, (answer) => {
        clearTimeout(timer)
        resolve(answer)
      })
      // While the host still starts, the call waits for it to report ready.
      if (!this.host.post({ type: 'terminal-host:call', callId, call })) {
        this.pending.push({ callId, call })
      }
    })
  }

  private flushPending(): void {
    for (const { callId, call } of this.pending.splice(0)) {
      if (!this.host.post({ type: 'terminal-host:call', callId, call })) {
        this.pending.push({ callId, call })
      }
    }
  }

  /** Terminals running a command, or none when the host is not running or does not answer. */
  busy(timeoutMs: number): Promise<BusyTerminal[]> {
    if (this.host.state !== 'ready') return Promise.resolve([])
    const requestId = this.nextBusyId++
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.busyRequests.delete(requestId)
        log.warn(`No busy answer within ${timeoutMs} ms`)
        resolve([])
      }, timeoutMs)
      this.busyRequests.set(requestId, (terminals) => {
        clearTimeout(timer)
        resolve(terminals)
      })
      this.host.post({ type: 'terminal-host:busy-request', requestId })
    })
  }

  stop(): Promise<void> {
    return this.host.stop()
  }

  private receive(message: TerminalHostToMain, deps: TerminalHostDeps): void {
    if (message.type === 'terminal-host:answer') {
      const resolve = this.calls.get(message.callId)
      if (!resolve) return
      this.calls.delete(message.callId)
      resolve(message.answer)
      return
    }
    if (message.type === 'terminal-host:handed-back') {
      const { sessionId, durationMs } = message
      if (typeof sessionId === 'string' && Number.isSafeInteger(durationMs) && durationMs >= 0) {
        deps.onHandedBack?.(sessionId, durationMs)
      }
      return
    }
    if (message.type !== 'terminal-host:busy') {
      log.warn(`Ignored unknown message "${message.type}"`)
      return
    }
    const resolve = this.busyRequests.get(message.requestId)
    if (!resolve) return
    this.busyRequests.delete(message.requestId)
    resolve(Array.isArray(message.terminals) ? message.terminals.filter(isBusyTerminal) : [])
  }
}
