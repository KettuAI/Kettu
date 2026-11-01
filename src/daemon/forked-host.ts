// One host under Node.js, as main's UtilityHost runs one in the desktop app: forked through its
// node-main.ts entry, restarted with main's backoff when it exits, and given up on after too many
// crashes. A host that takes ports listens on a private socket, the same one for every process it
// runs, so what was told the path can still reach it after a restart.

import { fork, type ChildProcess } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { privateSocketPath, type SocketPath } from '@shared/socket-port'
import type { Logger } from '../main/log'
import {
  DEFAULT_RESTART_POLICY,
  RestartPolicy,
  type RestartPolicyOptions,
} from '../main/restart-policy'

export type HostState =
  | 'idle' // never started
  | 'starting' // forked, waiting for its ready message
  | 'ready'
  | 'waiting' // exited, restart scheduled
  | 'failed' // crashed too often; not restarted again
  | 'stopping'
  | 'stopped'

export interface HostTimings {
  readyMs: number
  stopMs: number
  killGraceMs: number
}

// Main's UtilityHost waits as long.
const TIMINGS: HostTimings = { readyMs: 20_000, stopMs: 6000, killGraceMs: 2000 }

export interface ForkedHostConfig<ToChild, FromChild extends { type: string }> {
  log: Logger
  modulePath: string
  /** Names the folder of the socket the host takes ports on; null for a host that takes none. */
  socketName: string | null
  env: NodeJS.ProcessEnv
  initMessage(socketPath: string | null): ToChild
  shutdownMessage: ToChild
  readyType: FromChild['type']
  stoppedType: FromChild['type']
  onMessage(message: FromChild): void
  onReady?(): void
  /** Called once a process is gone; `clean` is false for a crash or a kill. */
  onExit?(clean: boolean): void
  timings?: HostTimings
  policy?: RestartPolicyOptions
}

class Unavailable extends Error {}

const FAILED = 'down: it exited too often'
const STOPPING = 'stopping'

/** Why a host cannot be reached: it failed, or the daemon is stopping. */
export function isUnavailable(error: unknown): error is Error {
  return error instanceof Unavailable
}

interface Waiter {
  resolve(): void
  reject(error: Error): void
}

export class ForkedHost<ToChild, FromChild extends { type: string }> {
  private child: ChildProcess | null = null
  private folder: SocketPath | null = null
  private status: HostState = 'idle'
  private readonly policy: RestartPolicy
  private readonly timings: HostTimings
  private readonly waiters: Waiter[] = []
  private restartTimer: NodeJS.Timeout | null = null
  private readyTimer: NodeJS.Timeout | null = null
  private exited: Promise<void> | null = null
  private cleanStop = false
  private shutDown = false
  private restartCount = 0

  constructor(private readonly config: ForkedHostConfig<ToChild, FromChild>) {
    this.policy = new RestartPolicy(config.policy ?? DEFAULT_RESTART_POLICY)
    this.timings = config.timings ?? TIMINGS
  }

  get state(): HostState {
    return this.status
  }

  get pid(): number | null {
    return this.child?.pid ?? null
  }

  /** How many times the host was restarted after it exited. */
  get restarts(): number {
    return this.restartCount
  }

  /** The socket the host takes ports on, from its first start until it is stopped. */
  get socketPath(): string | null {
    return this.folder?.path ?? null
  }

  /** Starts the process if it is not running; a no-op once stopped, failed or waiting. */
  start(): void {
    if (this.shutDown || this.status !== 'idle') return
    void this.spawn()
  }

  /** A restart the owner asked for after the host failed, as main's; ignored in any other state. */
  restart(): boolean {
    if (this.shutDown || this.status !== 'failed') return false
    this.policy.reset()
    this.config.log.info('Restarting, as the owner asked')
    void this.spawn()
    return true
  }

  /** Settles once the host is ready, starting it if it never ran; rejects once it cannot run. */
  ready(): Promise<void> {
    if (this.status === 'ready') return Promise.resolve()
    if (this.shutDown || this.status === 'failed') {
      return Promise.reject(new Unavailable(this.status === 'failed' ? FAILED : STOPPING))
    }
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject })
      this.start()
    })
  }

  /** Posts to the process if it runs; messages sent before it is ready wait behind its init. */
  post(message: ToChild): boolean {
    const child = this.child
    if (!child?.connected || this.status === 'stopping') return false
    child.send(message as object)
    return true
  }

  /**
   * Asks the process to exit and waits for it, killing it if it does not, then removes its socket.
   * Nothing restarts afterwards.
   */
  async stop(): Promise<void> {
    this.shutDown = true
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    this.rejectWaiters(STOPPING)
    if (!(await this.end())) this.status = 'stopped'
    await this.removeFolder()
  }

  /**
   * Stops the process as stop() does and starts a new one at once, with a new init message, on
   * the socket it had; it counts as no crash. A no-op once stopped or failed.
   */
  async renew(): Promise<void> {
    if (this.shutDown || this.status === 'failed') return
    this.config.log.info('Renewing it')
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    await this.end()
    // stop() came while the process ended.
    if (this.shutDown) return
    await this.spawn()
  }

  /** Asks the process to exit and waits for it, killing it if it does not; false without one. */
  private async end(): Promise<boolean> {
    const child = this.child
    const exited = this.exited
    if (!child || !exited) return false
    this.status = 'stopping'
    if (child.connected) child.send(this.config.shutdownMessage as object)
    if (!(await settles(exited, this.timings.stopMs))) {
      this.config.log.warn(`Did not exit within ${this.timings.stopMs} ms; killing it`)
      child.kill('SIGTERM')
      if (!(await settles(exited, this.timings.killGraceMs))) {
        child.kill('SIGKILL')
        await exited
      }
    }
    return true
  }

  private async spawn(): Promise<void> {
    this.cleanStop = false
    this.status = 'starting'
    let socketPath: string | null = null
    try {
      if (this.config.socketName) {
        this.folder ??= await privateSocketPath(this.config.socketName)
        socketPath = this.folder.path
        // Left by a process that was killed, which would keep the next one from listening.
        if (process.platform !== 'win32') await rm(socketPath, { force: true })
      }
    } catch (error) {
      this.config.log.error('Could not prepare its socket', error)
      this.scheduleRestart()
      return
    }
    // stop() came while the socket was prepared.
    if (this.shutDown) {
      await this.removeFolder()
      return
    }
    let child: ChildProcess
    try {
      child = fork(this.config.modulePath, [], {
        env: this.config.env,
        // Never the daemon's own flags, such as --inspect, which a second process cannot take.
        execArgv: [],
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        // A group of its own, so Ctrl+C in the daemon's terminal reaches the daemon alone, which
        // stops the host in order; without the daemon the host stops when its IPC disconnects.
        detached: true,
      })
    } catch (error) {
      this.config.log.error('Could not start', error)
      this.scheduleRestart()
      return
    }
    this.child = child
    this.forwardOutput(child)
    child.on('message', (message: unknown) => this.receive(child, message))
    this.exited = new Promise((resolve) => {
      let done = false
      const exit = (detail: string): void => {
        if (done) return
        done = true
        this.handleExit(child, detail)
        resolve()
      }
      child.once('exit', (code, signal) => exit(signal ? `signal ${signal}` : `code ${code}`))
      // A process that never started reports this alone.
      child.on('error', (error) => {
        this.config.log.error('Process error', error)
        if (child.pid === undefined) exit('no process')
      })
    })
    child.send(this.config.initMessage(socketPath) as object)
    this.readyTimer = setTimeout(() => {
      this.config.log.error(`No ready message within ${this.timings.readyMs} ms; killing it`)
      child.kill('SIGKILL')
    }, this.timings.readyMs)
  }

  private receive(child: ChildProcess, message: unknown): void {
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
      this.config.log.info(`Ready (pid ${child.pid})`)
      for (const waiter of this.waiters.splice(0)) waiter.resolve()
      try {
        this.config.onReady?.()
      } catch (error) {
        this.config.log.error('Ready handler failed', error)
      }
      return
    }
    if (typed.type === this.config.stoppedType) {
      this.cleanStop = true
      return
    }
    try {
      this.config.onMessage(typed)
    } catch (error) {
      this.config.log.error(`Failed to handle "${typed.type}"`, error)
    }
  }

  private handleExit(child: ChildProcess, detail: string): void {
    if (child !== this.child) return
    if (this.readyTimer) clearTimeout(this.readyTimer)
    this.readyTimer = null
    this.child = null
    this.exited = null
    const clean = this.cleanStop
    try {
      this.config.onExit?.(clean)
    } catch (error) {
      this.config.log.error('Exit handler failed', error)
    }
    if (this.status === 'stopping' || this.shutDown) {
      this.status = 'stopped'
      this.config.log.info(
        `Stopped with ${detail}${clean ? '' : ' without reporting a clean stop'}`,
      )
      return
    }
    this.config.log.error(`Exited unexpectedly with ${detail}`)
    this.scheduleRestart()
  }

  private scheduleRestart(): void {
    if (this.shutDown) {
      this.status = 'stopped'
      return
    }
    const decision = this.policy.crashed(Date.now())
    if (decision.kind === 'give-up') {
      this.status = 'failed'
      this.config.log.error('Crashed too often; not restarting it')
      this.rejectWaiters(FAILED)
      return
    }
    this.status = 'waiting'
    this.restartCount++
    this.config.log.info(`Restarting in ${decision.delayMs} ms`)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (!this.shutDown) void this.spawn()
    }, decision.delayMs)
  }

  private async removeFolder(): Promise<void> {
    const folder = this.folder
    this.folder = null
    await folder?.remove().catch((error: unknown) => {
      this.config.log.warn(`Could not remove its socket folder: ${(error as Error).message}`)
    })
  }

  private rejectWaiters(reason: string): void {
    for (const waiter of this.waiters.splice(0)) waiter.reject(new Unavailable(reason))
  }

  private forwardOutput(child: ChildProcess): void {
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
    forward(child.stdout, (line) => this.config.log.info(line))
    forward(child.stderr, (line) => this.config.log.warn(line))
  }
}

/** Whether `promise` settles within `ms`. */
function settles(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}
