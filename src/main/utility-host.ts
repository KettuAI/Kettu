import {
  BrowserWindow,
  MessageChannelMain,
  utilityProcess,
  type UtilityProcess,
  type WebContents,
} from 'electron'
import type { HostResetEvent } from '@shared/ipc'
import { createLogger, type Logger } from './log'
import { RestartPolicy } from './restart-policy'

export type UtilityHostState =
  | 'idle' // never started
  | 'starting' // forked, waiting for its ready message
  | 'ready'
  | 'waiting' // crashed, restart scheduled
  | 'failed' // crashed too often; waits for the user
  | 'stopping'
  | 'stopped'

export interface UtilityHostEvent {
  at: number
  event: 'start' | 'ready' | 'exit' | 'crash' | 'restart-scheduled' | 'failed' | 'user-restart'
  detail?: string
}

export interface UtilityHostConfig<ToChild, FromChild extends { type: string }> {
  label: string
  /** Prefix of the preload channels: `<channel>:port` and `<channel>:reset`. */
  channel: 'agent-host' | 'terminal-host'
  modulePath: string
  serviceName: string
  initMessage(): ToChild
  connectMessage(windowId: number): ToChild
  shutdownMessage: ToChild
  readyType: FromChild['type']
  stoppedType: FromChild['type']
  onMessage(message: FromChild): void
  /** Called once the process is gone; `clean` is false for a crash or a kill. */
  onExit?(clean: boolean): void
}

const READY_TIMEOUT_MS = 20_000
const STOP_TIMEOUT_MS = 6000
const KILL_GRACE_MS = 2000
const HISTORY_LIMIT = 100

/**
 * Runs one utility process: forks it, hands a MessagePort to every page that asks, restarts it
 * with backoff when it crashes and gives up after too many crashes until the user restarts it.
 */
export class UtilityHost<ToChild, FromChild extends { type: string }> {
  private child: UtilityProcess | null = null
  private status: UtilityHostState = 'idle'
  private readonly policy = new RestartPolicy()
  private readonly clients = new Set<WebContents>()
  private readonly pendingConnects = new Map<number, WebContents>()
  private readonly events: UtilityHostEvent[] = []
  private readonly log: Logger
  private restartTimer: NodeJS.Timeout | null = null
  private readyTimer: NodeJS.Timeout | null = null
  private exited: Promise<void> | null = null
  private cleanStop = false
  private shutDown = false

  constructor(private readonly config: UtilityHostConfig<ToChild, FromChild>) {
    this.log = createLogger(config.label)
  }

  get state(): UtilityHostState {
    return this.status
  }

  get pid(): number | null {
    return this.child?.pid ?? null
  }

  history(): UtilityHostEvent[] {
    return this.events.slice()
  }

  /** Starts the process if it is not running; a no-op once shut down or while it has failed. */
  start(): void {
    if (this.shutDown || this.child || this.status === 'waiting' || this.status === 'failed') return
    this.spawn()
  }

  /** A restart the user asked for after the process failed; ignored in any other state. */
  restart(): boolean {
    if (this.shutDown || this.status !== 'failed') return false
    this.policy.reset()
    this.record('user-restart')
    this.resetClients(false)
    this.spawn()
    return true
  }

  /** Hands a fresh port to the page in `webContents`, now or as soon as the process is ready. */
  connect(webContents: WebContents): void {
    if (webContents.isDestroyed()) return
    if (!this.clients.has(webContents)) {
      this.clients.add(webContents)
      webContents.once('destroyed', () => {
        this.clients.delete(webContents)
        this.pendingConnects.delete(webContents.id)
      })
    }
    if (this.shutDown) return
    if (this.status === 'failed') {
      this.sendReset(webContents, true)
      return
    }
    if (this.status === 'ready') {
      this.handOff(webContents)
      return
    }
    this.pendingConnects.set(webContents.id, webContents)
    this.start()
  }

  /** Takes the page's port away; it gets a new one only by asking again through IPC. */
  revoke(webContents: WebContents): void {
    this.pendingConnects.delete(webContents.id)
    this.sendReset(webContents, true)
  }

  /** Posts to the process if it exists; messages sent before it is ready queue behind init. */
  post(message: ToChild): boolean {
    if (!this.child || this.status === 'stopping') return false
    this.child.postMessage(message)
    return true
  }

  /** Asks the process to exit and waits for it; kills it after 6 s. Nothing restarts afterwards. */
  async stop(timeoutMs = STOP_TIMEOUT_MS): Promise<void> {
    this.shutDown = true
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    this.pendingConnects.clear()
    const child = this.child
    if (!child || !this.exited) {
      this.status = 'stopped'
      return
    }
    const exited = this.exited
    this.status = 'stopping'
    child.postMessage(this.config.shutdownMessage)
    const timedOut = await Promise.race([
      exited.then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), timeoutMs)),
    ])
    if (!timedOut) return
    this.log.warn(`Did not exit within ${timeoutMs} ms; killing it`)
    const pid = child.pid
    child.kill()
    const gone = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), KILL_GRACE_MS)),
    ])
    // kill() sends SIGTERM on macOS and Linux, which a process can ignore; quitting must not wait.
    if (!gone && pid && process.platform !== 'win32') {
      try {
        process.kill(pid, 'SIGKILL')
      } catch (error) {
        this.log.error('Could not kill it', error)
      }
    }
  }

  private spawn(): void {
    this.cleanStop = false
    this.status = 'starting'
    this.record('start')
    let child: UtilityProcess
    try {
      child = utilityProcess.fork(this.config.modulePath, [], {
        serviceName: this.config.serviceName,
        stdio: 'pipe',
      })
    } catch (error) {
      this.record('crash', 'fork failed')
      this.log.error('Could not start', error)
      this.scheduleRestart()
      return
    }
    this.child = child
    this.forwardOutput(child)
    child.on('message', (message: unknown) => this.receive(child, message))
    child.on('error', (type, location) => this.log.error(`${type} at ${location}`))
    this.exited = new Promise((resolve) => {
      child.once('exit', (code) => {
        this.handleExit(child, code)
        resolve()
      })
    })
    child.postMessage(this.config.initMessage())
    this.readyTimer = setTimeout(() => {
      this.log.error(`No ready message within ${READY_TIMEOUT_MS} ms; killing it`)
      child.kill()
    }, READY_TIMEOUT_MS)
  }

  private receive(child: UtilityProcess, message: unknown): void {
    if (child !== this.child) return
    if (typeof message !== 'object' || message === null) return
    const typed = message as FromChild
    if (typeof typed.type !== 'string') return
    if (typed.type === this.config.readyType) {
      if (this.readyTimer) clearTimeout(this.readyTimer)
      this.readyTimer = null
      if (this.status !== 'starting') return
      this.status = 'ready'
      this.policy.ready(Date.now())
      this.record('ready', child.pid ? `pid ${child.pid}` : undefined)
      this.log.info(`Ready (pid ${child.pid ?? 'unknown'})`)
      const pending = [...this.pendingConnects.values()]
      this.pendingConnects.clear()
      for (const webContents of pending) this.handOff(webContents)
      return
    }
    if (typed.type === this.config.stoppedType) {
      this.cleanStop = true
      return
    }
    try {
      this.config.onMessage(typed)
    } catch (error) {
      this.log.error(`Failed to handle "${typed.type}"`, error)
    }
  }

  private handleExit(child: UtilityProcess, code: number): void {
    if (child !== this.child) return
    if (this.readyTimer) clearTimeout(this.readyTimer)
    this.readyTimer = null
    this.child = null
    this.exited = null
    const clean = this.cleanStop
    try {
      this.config.onExit?.(clean)
    } catch (error) {
      this.log.error('Exit handler failed', error)
    }
    if (this.status === 'stopping' || this.shutDown) {
      this.status = 'stopped'
      this.record('exit', `code ${code}`)
      this.log.info(`Stopped with code ${code}${clean ? '' : ' without reporting a clean stop'}`)
      return
    }
    this.record('crash', `code ${code}`)
    this.log.error(`Exited unexpectedly with code ${code}`)
    this.scheduleRestart()
  }

  private scheduleRestart(): void {
    const decision = this.policy.crashed(Date.now())
    if (decision.kind === 'give-up') {
      this.status = 'failed'
      this.record('failed')
      this.log.error('Crashed too often; not restarting until asked')
      this.pendingConnects.clear()
      this.resetClients(true)
      return
    }
    this.status = 'waiting'
    this.record('restart-scheduled', `${decision.delayMs} ms`)
    this.resetClients(false)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (!this.shutDown) this.spawn()
    }, decision.delayMs)
  }

  private handOff(webContents: WebContents): void {
    if (webContents.isDestroyed() || !this.child) return
    const windowId = BrowserWindow.fromWebContents(webContents)?.id ?? -1
    const { port1, port2 } = new MessageChannelMain()
    this.child.postMessage(this.config.connectMessage(windowId), [port1])
    webContents.postMessage(`${this.config.channel}:port`, null, [port2])
  }

  private resetClients(failed: boolean): void {
    for (const webContents of this.clients) this.sendReset(webContents, failed)
  }

  private sendReset(webContents: WebContents, failed: boolean): void {
    if (webContents.isDestroyed()) return
    const event: HostResetEvent = { failed }
    webContents.send(`${this.config.channel}:reset`, event)
  }

  private forwardOutput(child: UtilityProcess): void {
    const forward = (stream: NodeJS.ReadableStream | null, write: (line: string) => void): void => {
      if (!stream) return
      let partial = ''
      stream.setEncoding('utf8')
      stream.on('data', (chunk: string) => {
        const lines = (partial + chunk).split(/\r?\n/)
        partial = lines.pop() ?? ''
        for (const line of lines) if (line.length > 0) write(line)
      })
      stream.on('end', () => {
        if (partial.length > 0) write(partial)
        partial = ''
      })
    }
    forward(child.stdout, (line) => this.log.info(line))
    forward(child.stderr, (line) => this.log.warn(line))
  }

  private record(event: UtilityHostEvent['event'], detail?: string): void {
    this.events.push({ at: Date.now(), event, ...(detail ? { detail } : {}) })
    if (this.events.length > HISTORY_LIMIT)
      this.events.splice(0, this.events.length - HISTORY_LIMIT)
  }
}
