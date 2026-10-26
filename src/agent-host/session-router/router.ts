// A small ACP router for an adapter that keeps one live session per process, as pi-acp 0.0.34
// does: it speaks ACP on its stdio and runs one adapter process for the control requests and one
// per session, so an adapter only ever holds the session its own process has.
//
// Run as `<node> <router> <node> <adapter entry>`: the words after the router are the command line
// of every child. It imports Node's built-ins only, so its bundle is one file.

import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'

type JsonRpcId = string | number
interface RpcError {
  code: number
  message: string
  data?: unknown
}
interface RpcMessage {
  jsonrpc?: string
  id?: JsonRpcId
  method?: string
  params?: unknown
  result?: unknown
  error?: RpcError
}

interface Deferred {
  resolve(message: RpcMessage): void
  reject(error: Error): void
}

/** A child adapter process, its stdio lines and the requests waiting for its answers. */
class Child {
  /** Set before the router ends it, so its exit is not a crash. */
  ending = false
  exited = false
  /** Whether the router took its exit into account, so a later event is ignored. */
  gone = false
  readonly outgoing = new Map<JsonRpcId, Deferred>()
  readonly proc: ChildProcess

  constructor(proc: ChildProcess) {
    this.proc = proc
  }
}

/** The JSON-RPC code for a request that names a session the router has no child for. */
const INVALID_PARAMS = -32602
const INTERNAL_ERROR = -32603

/** How long a released session's child may take to exit before the router kills it. */
const CLOSE_KILL_MS = 5_000
/** How long an import's or a delete's child may take to exit before the router kills it. */
const REPLACE_KILL_MS = 2_000
/** How long the router waits for its children once its own input ends. */
const STOP_MS = 1_500

// cmd.exe quoting for a `.cmd` or `.bat` child, which Node.js refuses to spawn without a shell.
const CMD_UNSAFE = /[\s&|<>()^"%!,;=]/

function quoteCmd(arg: string): string {
  return arg !== '' && !CMD_UNSAFE.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`
}

/** The `sessionId` a message names, or null. */
function sessionIdOf(params: unknown): string | null {
  if (typeof params !== 'object' || params === null) return null
  const id = (params as { sessionId?: unknown }).sessionId
  return typeof id === 'string' ? id : null
}

/** Adds `sessionCapabilities.close`, which the router provides over pi-acp's single sessions. */
function withClose(result: unknown): unknown {
  if (typeof result !== 'object' || result === null) return result
  const response = result as Record<string, unknown>
  const capabilities =
    typeof response.agentCapabilities === 'object' && response.agentCapabilities !== null
      ? (response.agentCapabilities as Record<string, unknown>)
      : {}
  const sessions =
    typeof capabilities.sessionCapabilities === 'object' &&
    capabilities.sessionCapabilities !== null
      ? (capabilities.sessionCapabilities as Record<string, unknown>)
      : {}
  capabilities.sessionCapabilities = { ...sessions, close: sessions.close ?? {} }
  response.agentCapabilities = capabilities
  return response
}

function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (check()) {
      resolve(true)
      return
    }
    const started = Date.now()
    const timer = setInterval(() => {
      if (check()) {
        clearInterval(timer)
        resolve(true)
      } else if (Date.now() - started >= ms) {
        clearInterval(timer)
        resolve(false)
      }
    }, 10)
    timer.unref?.()
  })
}

export class SessionRouter {
  private readonly childCommand: string
  private readonly childArgs: string[]
  private readonly children = new Set<Child>()
  /** Each live session's child, by the session id it opened. */
  private readonly sessions = new Map<string, Child>()
  /** The requests the router made to the host for its children, by the id it gave them. */
  private readonly hostRequests = new Map<JsonRpcId, Deferred>()
  private control: Child | null = null
  private initializeParams: unknown = null
  private nextId = 1
  private stopping = false
  private stopped = false

  constructor(command: string, args: string[]) {
    this.childCommand = command
    this.childArgs = args
  }

  start(): void {
    this.control = this.spawnChild()
    const input = createInterface({ input: process.stdin })
    input.on('line', (line) => this.receiveHost(line))
    input.on('close', () => this.stop())
  }

  // The host's messages.

  private receiveHost(line: string): void {
    const message = parse(line)
    if (!message) return
    if (message.method !== undefined) {
      if (message.id !== undefined)
        void this.hostRequest(message.id, message.method, message.params)
      else this.hostNotification(message.method, message.params)
    } else if (message.id !== undefined) {
      this.hostResponse(message)
    }
  }

  private async hostRequest(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    try {
      if (method === 'initialize') {
        this.initializeParams = params
        this.control ??= this.spawnChild()
        const answer = await this.request(this.control, method, params)
        if (answer.error) return this.sendError(id, answer.error)
        return this.sendResult(id, withClose(answer.result))
      }
      if (method === 'session/new') return await this.newSession(id, params)
      if (method === 'session/load') return await this.loadSession(id, params)
      if (method === 'session/close') return this.closeSession(id, params)
      if (method === 'session/delete') return await this.deleteSession(id, params)
      const sessionId = sessionIdOf(params)
      if (sessionId !== null) {
        const child = this.sessions.get(sessionId)
        if (!child) {
          return this.sendError(id, {
            code: INVALID_PARAMS,
            message: `Unknown session ${sessionId}`,
          })
        }
        const answer = await this.request(child, method, params)
        return answer.error ? this.sendError(id, answer.error) : this.sendResult(id, answer.result)
      }
      if (!this.control) {
        return this.sendError(id, { code: INTERNAL_ERROR, message: 'The router did not start' })
      }
      const answer = await this.request(this.control, method, params)
      return answer.error ? this.sendError(id, answer.error) : this.sendResult(id, answer.result)
    } catch (error) {
      this.sendError(id, { code: INTERNAL_ERROR, message: (error as Error).message })
    }
  }

  private hostNotification(method: string, params: unknown): void {
    const sessionId = sessionIdOf(params)
    if (sessionId !== null) {
      const child = this.sessions.get(sessionId)
      // A notification for a session without a child is dropped.
      if (child) this.send(child, { jsonrpc: '2.0', method, params })
      return
    }
    if (this.control) this.send(this.control, { jsonrpc: '2.0', method, params })
  }

  private hostResponse(message: RpcMessage): void {
    const deferred = this.hostRequests.get(message.id!)
    if (!deferred) return
    this.hostRequests.delete(message.id!)
    deferred.resolve(message)
  }

  // Sessions.

  private async newSession(id: JsonRpcId, params: unknown): Promise<void> {
    let child: Child | null = null
    try {
      child = await this.startSessionChild()
      const answer = await this.request(child, 'session/new', params)
      if (answer.error) {
        this.endChild(child)
        return this.sendError(id, answer.error)
      }
      const sessionId = (answer.result as { sessionId?: unknown } | null)?.sessionId
      if (typeof sessionId !== 'string') {
        this.endChild(child)
        return this.sendError(id, {
          code: INTERNAL_ERROR,
          message: 'session/new answered with no session id',
        })
      }
      this.sessions.set(sessionId, child)
      this.sendResult(id, answer.result)
    } catch (error) {
      if (child) this.endChild(child)
      this.sendError(id, { code: INTERNAL_ERROR, message: (error as Error).message })
    }
  }

  private async loadSession(id: JsonRpcId, params: unknown): Promise<void> {
    const sessionId = sessionIdOf(params)
    if (sessionId === null) {
      return this.sendError(id, {
        code: INVALID_PARAMS,
        message: 'session/load names no session',
      })
    }
    let child: Child | null = null
    try {
      const existing = this.sessions.get(sessionId)
      if (existing) {
        this.sessions.delete(sessionId)
        await this.endChildAndWait(existing, REPLACE_KILL_MS)
      }
      child = await this.startSessionChild()
      const answer = await this.request(child, 'session/load', params)
      if (answer.error) {
        this.endChild(child)
        return this.sendError(id, answer.error)
      }
      this.sessions.set(sessionId, child)
      this.sendResult(id, answer.result)
    } catch (error) {
      if (child) this.endChild(child)
      this.sendError(id, { code: INTERNAL_ERROR, message: (error as Error).message })
    }
  }

  private closeSession(id: JsonRpcId, params: unknown): void {
    const sessionId = sessionIdOf(params)
    const child = sessionId === null ? undefined : this.sessions.get(sessionId)
    if (sessionId !== null && child) {
      this.sessions.delete(sessionId)
      // Its stdin closes, so pi-acp exits; a child that does not is killed after the limit.
      this.endChild(child)
      const timer = setTimeout(() => this.killChild(child), CLOSE_KILL_MS)
      timer.unref?.()
    }
    this.sendResult(id, {})
  }

  private async deleteSession(id: JsonRpcId, params: unknown): Promise<void> {
    const sessionId = sessionIdOf(params)
    const child = sessionId === null ? undefined : this.sessions.get(sessionId)
    try {
      if (sessionId !== null && child) {
        this.sessions.delete(sessionId)
        // Wait for it to exit, so nothing writes the session again before the delete.
        await this.endChildAndWait(child, REPLACE_KILL_MS)
      }
      if (!this.control) throw new Error('The router did not start')
      const answer = await this.request(this.control, 'session/delete', params)
      return answer.error ? this.sendError(id, answer.error) : this.sendResult(id, answer.result)
    } catch (error) {
      this.sendError(id, { code: INTERNAL_ERROR, message: (error as Error).message })
    }
  }

  /** A child for a session, initialized with the parameters the host gave the control child. */
  private async startSessionChild(): Promise<Child> {
    if (this.initializeParams === null) throw new Error('The router is not initialized')
    const child = this.spawnChild()
    const answer = await this.request(child, 'initialize', this.initializeParams)
    if (answer.error) {
      this.endChild(child)
      throw new Error(answer.error.message)
    }
    return child
  }

  // Child processes.

  private spawnChild(): Child {
    const { command, args } = this.spawnWords(this.childCommand, this.childArgs)
    const proc = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: this.childShell,
      windowsHide: true,
    })
    const child = new Child(proc)
    this.children.add(child)
    if (proc.stdout) {
      const lines = createInterface({ input: proc.stdout })
      lines.on('line', (line) => this.receiveChild(child, line))
    }
    if (proc.stderr) {
      const errors = createInterface({ input: proc.stderr })
      errors.on('line', (line) => process.stderr.write(`${line}\n`))
    }
    proc.stdin?.on('error', () => {})
    proc.on('exit', () => this.childGone(child))
    proc.on('error', (error) => {
      process.stderr.write(`session-router: ${error.message}\n`)
      this.childGone(child)
    })
    return child
  }

  private get childShell(): boolean {
    return process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(this.childCommand)
  }

  /** The command and arguments to spawn: a `.cmd` or `.bat` goes through cmd.exe as one line. */
  private spawnWords(command: string, args: string[]): { command: string; args: string[] } {
    if (!this.childShell) return { command, args }
    return { command: [command, ...args].map(quoteCmd).join(' '), args: [] }
  }

  private receiveChild(child: Child, line: string): void {
    const message = parse(line)
    if (!message) return
    if (message.method !== undefined) {
      if (message.id !== undefined)
        this.forwardChildRequest(child, message.id, message.method, message.params)
      // Notifications pass as they are.
      else this.sendHost({ jsonrpc: '2.0', method: message.method, params: message.params })
      return
    }
    if (message.id === undefined) return
    const deferred = child.outgoing.get(message.id)
    if (!deferred) return
    child.outgoing.delete(message.id)
    deferred.resolve(message)
  }

  /** A request a child makes, such as a permission request, with an id the router owns. */
  private forwardChildRequest(
    child: Child,
    childId: JsonRpcId,
    method: string,
    params: unknown,
  ): void {
    const id = this.nextId++
    this.hostRequests.set(id, {
      resolve: (answer) =>
        this.send(child, {
          jsonrpc: '2.0',
          id: childId,
          ...(answer.error ? { error: answer.error } : { result: answer.result }),
        }),
      reject: () => {},
    })
    this.sendHost({ jsonrpc: '2.0', id, method, params })
  }

  private request(child: Child, method: string, params: unknown): Promise<RpcMessage> {
    const id = this.nextId++
    return new Promise<RpcMessage>((resolve, reject) => {
      child.outgoing.set(id, { resolve, reject })
      this.send(child, { jsonrpc: '2.0', id, method, params })
    })
  }

  private send(child: Child, message: RpcMessage): void {
    const input = child.proc.stdin
    if (!input || input.destroyed) return
    try {
      input.write(`${JSON.stringify(message)}\n`)
    } catch {
      // A write to an exited child fails with EPIPE; its exit is what reports it.
    }
  }

  private sendHost(message: RpcMessage): void {
    if (this.stopped) return
    try {
      process.stdout.write(`${JSON.stringify(message)}\n`)
    } catch {
      // The host ended its input; the stop below takes over.
    }
  }

  private sendResult(id: JsonRpcId, result: unknown): void {
    this.sendHost({ jsonrpc: '2.0', id, result: result ?? {} })
  }

  private sendError(id: JsonRpcId, error: RpcError): void {
    this.sendHost({ jsonrpc: '2.0', id, error })
  }

  /** Ends a child without waiting: its stdin closes, and it may be killed after a limit. */
  private endChild(child: Child): void {
    child.ending = true
    child.proc.stdin?.end()
  }

  private async endChildAndWait(child: Child, ms: number): Promise<void> {
    this.endChild(child)
    if (await waitFor(() => child.exited, ms)) return
    this.killChild(child)
    await waitFor(() => child.exited, REPLACE_KILL_MS)
  }

  private killChild(child: Child): void {
    if (child.exited || !child.proc.pid) return
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(child.proc.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      killer.on('error', () => {})
      return
    }
    child.proc.kill('SIGKILL')
  }

  /**
   * A child exited. An ending one is the router's own doing; any other means the adapter crashed,
   * so the router ends the rest and exits with code 1, which the host takes as a crash.
   */
  private childGone(child: Child): void {
    if (child.gone) return
    child.gone = true
    child.exited = true
    this.children.delete(child)
    for (const deferred of child.outgoing.values()) {
      deferred.reject(new Error('The agent process exited'))
    }
    child.outgoing.clear()
    if (child.ending) {
      if (this.stopping && this.children.size === 0) this.finish(0)
      return
    }
    if (child === this.control) this.control = null
    for (const other of this.children) {
      other.ending = true
      this.killChild(other)
    }
    this.finish(1)
  }

  /** Its own input ended: every child goes, and the router exits once they have or after the limit. */
  private stop(): void {
    if (this.stopping) return
    this.stopping = true
    if (this.children.size === 0) {
      this.finish(0)
      return
    }
    for (const child of this.children) this.endChild(child)
    const timer = setTimeout(() => {
      for (const child of this.children) this.killChild(child)
      this.finish(0)
    }, STOP_MS)
    timer.unref?.()
  }

  private finish(code: number): void {
    if (this.stopped) return
    this.stopped = true
    process.exit(code)
  }
}

function parse(line: string): RpcMessage | null {
  try {
    const parsed: unknown = JSON.parse(line)
    return typeof parsed === 'object' && parsed !== null ? (parsed as RpcMessage) : null
  } catch {
    return null
  }
}

// The host starts this file as `<node> <router> <node> <adapter entry>`; it is never imported.
const command = process.argv[2]
if (!command) {
  process.stderr.write('session-router: no agent command line\n')
  process.exit(1)
}
new SessionRouter(command, process.argv.slice(3)).start()
