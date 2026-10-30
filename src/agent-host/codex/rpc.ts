// JSON-RPC 2.0 between Kettu and `codex app-server`, one message per line. Codex sends its own
// messages without the `jsonrpc` field; both forms are read.

import { Readable, Writable } from 'node:stream'
import { ndJsonStream } from '@agentclientprotocol/sdk/unstable'
import type { AgentTransport } from '../driver'
import type { RequestId } from './protocol'

export interface MessageStream {
  readable: ReadableStream<unknown>
  writable: WritableStream<unknown>
}

/** An error answer to a request. */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message)
    this.name = 'RpcError'
  }
}

/** The connection closed before the answer came. */
export class RpcClosed extends Error {
  constructor() {
    super('The Codex app-server connection closed')
    this.name = 'RpcClosed'
  }
}

export interface RpcHandlers {
  notification(method: string, params: unknown): void
  /** Answers a request of the server's; `signal` aborts once the server withdraws it. */
  request(method: string, params: unknown, id: RequestId, signal: AbortSignal): Promise<unknown>
  traffic(direction: 'in' | 'out', message: unknown): void
  log(level: 'warn', message: string): void
}

const METHOD_NOT_FOUND = -32601
const INTERNAL_ERROR = -32603

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
}

/** The message stream over what the launcher gave the driver. */
export function messageStream(transport: AgentTransport): { stream: MessageStream; close(): void } {
  if (transport.kind === 'stdio') {
    const stream = ndJsonStream(
      Writable.toWeb(transport.stdin as Writable) as WritableStream<Uint8Array>,
      Readable.toWeb(transport.stdout as Readable) as ReadableStream<Uint8Array>,
    )
    return { stream: stream as MessageStream, close: () => {} }
  }
  return { stream: transport.stream, close: () => transport.close() }
}

export class RpcPeer {
  private readonly pending = new Map<RequestId, Pending>()
  private readonly served = new Map<string, AbortController>()
  private readonly writer: WritableStreamDefaultWriter<unknown>
  private nextId = 1
  private ended = false
  private readonly done: Promise<void>
  private markDone!: () => void

  constructor(
    private readonly stream: MessageStream,
    private readonly handlers: RpcHandlers,
    private readonly onClose: () => void = () => {},
  ) {
    this.done = new Promise((resolve) => (this.markDone = resolve))
    this.writer = stream.writable.getWriter()
    void this.read()
  }

  get closed(): Promise<void> {
    return this.done
  }

  get isClosed(): boolean {
    return this.ended
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    if (this.ended) return Promise.reject(new RpcClosed())
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      this.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
    })
  }

  notify(method: string, params?: unknown): void {
    if (this.ended) return
    this.send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })
  }

  /** Aborts the server's request `id`, which it no longer waits for. */
  withdraw(id: RequestId): boolean {
    const served = this.served.get(String(id))
    if (!served) return false
    served.abort(new Error('The request was withdrawn'))
    return true
  }

  close(): void {
    if (this.ended) return
    this.finish()
    void this.writer.close().catch(() => {})
  }

  private send(message: unknown): void {
    this.handlers.traffic('out', message)
    this.writer.write(message).catch(() => this.finish())
  }

  private async read(): Promise<void> {
    const reader = this.stream.readable.getReader()
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done || this.ended) break
        this.receive(value)
      }
    } catch {
      // A stream that failed ends the connection like one that closed.
    } finally {
      reader.releaseLock()
      this.finish()
    }
  }

  private receive(message: unknown): void {
    this.handlers.traffic('in', message)
    if (typeof message !== 'object' || message === null || Array.isArray(message)) return
    const { id, method, params, result, error } = message as {
      id?: RequestId
      method?: unknown
      params?: unknown
      result?: unknown
      error?: { code?: unknown; message?: unknown; data?: unknown }
    }
    if (typeof method === 'string') {
      if (id === undefined || id === null) this.handlers.notification(method, params)
      else void this.serve(id, method, params)
      return
    }
    if (id === undefined || id === null) return
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    if (error) {
      pending.reject(
        new RpcError(
          typeof error.code === 'number' ? error.code : INTERNAL_ERROR,
          typeof error.message === 'string' ? error.message : 'Unknown error',
          error.data,
        ),
      )
    } else {
      pending.resolve(result)
    }
  }

  private async serve(id: RequestId, method: string, params: unknown): Promise<void> {
    const abort = new AbortController()
    this.served.set(String(id), abort)
    try {
      const result = await this.handlers.request(method, params, id, abort.signal)
      if (!abort.signal.aborted) this.send({ jsonrpc: '2.0', id, result })
    } catch (error) {
      if (abort.signal.aborted || this.ended) return
      const code = error instanceof RpcError ? error.code : INTERNAL_ERROR
      if (!(error instanceof RpcError)) {
        this.handlers.log('warn', `Codex request ${method} failed: ${(error as Error).message}`)
      }
      this.send({ jsonrpc: '2.0', id, error: { code, message: (error as Error).message } })
    } finally {
      this.served.delete(String(id))
    }
  }

  private finish(): void {
    if (this.ended) return
    this.ended = true
    for (const pending of this.pending.values()) pending.reject(new RpcClosed())
    this.pending.clear()
    for (const served of this.served.values()) served.abort(new RpcClosed())
    this.served.clear()
    this.onClose()
    this.markDone()
  }
}

export function methodNotFound(method: string): RpcError {
  return new RpcError(METHOD_NOT_FOUND, `Kettu does not handle ${method}`)
}
