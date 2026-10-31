import { app, MessageChannelMain, type MessagePortMain, type WebContents } from 'electron'
import type { BusyTerminal, MainToTerminalHost, TerminalHostToMain } from '@shared/host-control'
import type { PortDevice } from '@shared/remote/device'
import type { TerminalSettings } from '@shared/settings'
import terminalHostPath from '../terminal-host/index?modulePath'
import { createLogger } from './log'
import { UtilityHost, type UtilityHostEvent, type UtilityHostState } from './utility-host'

const log = createLogger('terminal-host')

export interface TerminalHostDeps {
  settings(): TerminalSettings
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
        settings: deps.settings(),
        projects: this.projects,
        authCommands: this.authCommands,
      }),
      connectMessage: (windowId) => ({ type: 'terminal-host:connect', windowId }),
      shutdownMessage: { type: 'terminal-host:shutdown' },
      readyType: 'terminal-host:ready',
      stoppedType: 'terminal-host:stopped',
      onMessage: (message) => this.receive(message),
      onExit: () => {
        for (const resolve of this.busyRequests.values()) resolve([])
        this.busyRequests.clear()
      },
    })
  }

  get state(): UtilityHostState {
    return this.host.state
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

  setProjects(paths: string[]): void {
    this.projects = paths
    this.host.post({ type: 'terminal-host:projects', paths })
  }

  setAuthCommands(commands: string[]): void {
    this.authCommands = commands
    this.host.post({ type: 'terminal-host:auth-commands', commands })
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

  private receive(message: TerminalHostToMain): void {
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
