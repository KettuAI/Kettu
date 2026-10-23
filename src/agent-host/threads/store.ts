// The host's side of the thread database: a promise API over the thread worker, which owns the
// SQLite file, so no query runs on the event loop that streams the sessions.

import type { Worker } from 'node:worker_threads'
import type { LogFn } from '../storage'
import type { StoredBlob, StoredThread, ThreadPage, ThreadWrite } from './model'
import type { ThreadDbStatus, ThreadErrorCode, ThreadReply, ThreadRequest } from './protocol'

/** What the store needs of a worker, so tests can run the service in their own thread. */
export interface ThreadWorker {
  postMessage(request: ThreadRequest): void
  onMessage(listener: (reply: ThreadReply) => void): void
  /** Called once when the worker stops, with the error that stopped it, if any. */
  onExit(listener: (error: Error | null) => void): void
  terminate(): Promise<unknown>
}

export type ThreadWorkerFactory = (file: string) => ThreadWorker

export function nodeThreadWorker(worker: Worker): ThreadWorker {
  return {
    postMessage: (request) => worker.postMessage(request),
    onMessage: (listener) => worker.on('message', listener),
    onExit: (listener) => {
      let failure: Error | null = null
      worker.on('error', (error) => {
        failure = error
      })
      worker.on('exit', (code) =>
        listener(failure ?? (code === 0 ? null : new Error(`exited with code ${code}`))),
      )
    },
    terminate: () => worker.terminate(),
  }
}

export class ThreadStoreError extends Error {
  constructor(
    message: string,
    readonly code: ThreadErrorCode | null,
  ) {
    super(message)
    this.name = 'ThreadStoreError'
  }
}

export interface ThreadStoreOptions {
  file: string
  createWorker: ThreadWorkerFactory
  log: LogFn
  /** How long closing waits for the worker to fold the WAL before stopping it. */
  closeTimeoutMs?: number
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never
type Request = WithoutId<ThreadRequest>

export class ThreadStore {
  /** How the database opened; `unavailable` when the worker never got that far. */
  readonly ready: Promise<ThreadDbStatus>
  private readonly worker: ThreadWorker
  private readonly pending = new Map<number, Pending>()
  private readonly inflight = new Set<Promise<unknown>>()
  private nextId = 1
  /** Why requests fail at once: the worker stopped, or the store closed. */
  private stopped: string | null = null
  private closing: Promise<void> | null = null

  constructor(private readonly options: ThreadStoreOptions) {
    let settleReady: (status: ThreadDbStatus) => void = () => {}
    this.ready = new Promise((resolve) => {
      settleReady = resolve
    })
    this.worker = options.createWorker(options.file)
    this.worker.onMessage((reply) => {
      switch (reply.type) {
        case 'ready':
          settleReady(reply.status)
          break
        case 'log':
          options.log(reply.level, `Thread database: ${reply.message}`)
          break
        case 'result':
          this.settle(reply.id)?.resolve(reply.value)
          break
        case 'error':
          this.settle(reply.id)?.reject(new ThreadStoreError(reply.message, reply.code))
          break
      }
    })
    this.worker.onExit((error) => {
      settleReady('unavailable')
      if (this.closing) return
      const reason = `The thread worker stopped${error ? `: ${error.message}` : ''}`
      options.log('error', reason)
      this.stop(reason)
    })
  }

  private settle(id: number): Pending | undefined {
    const pending = this.pending.get(id)
    this.pending.delete(id)
    return pending
  }

  private stop(reason: string): void {
    this.stopped = reason
    for (const pending of this.pending.values()) {
      pending.reject(new ThreadStoreError(reason, 'unavailable'))
    }
    this.pending.clear()
  }

  private request<T>(request: Request): Promise<T> {
    if (this.stopped) return Promise.reject(new ThreadStoreError(this.stopped, 'unavailable'))
    const id = this.nextId++
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
    })
    this.worker.postMessage({ ...request, id } as ThreadRequest)
    const done = (): void => {
      this.inflight.delete(promise)
    }
    this.inflight.add(promise)
    promise.then(done, done)
    return promise
  }

  /** The page ending below `before`, or the latest page; null when the session has no thread. */
  page(sessionId: string, before: number | null = null): Promise<ThreadPage | null> {
    return this.request({ op: 'page', sessionId, before })
  }

  /** Everything from `from` on; null when the session has no thread. */
  tail(sessionId: string, from: number): Promise<ThreadPage | null> {
    return this.request({ op: 'tail', sessionId, from })
  }

  /** The whole thread; null when the session has none, or part of it does not parse. */
  load(sessionId: string): Promise<StoredThread | null> {
    return this.request({ op: 'load', sessionId })
  }

  write(sessionId: string, change: ThreadWrite): Promise<void> {
    return this.request({ op: 'write', sessionId, change })
  }

  remove(sessionIds: readonly string[]): Promise<void> {
    return this.request({ op: 'remove', sessionIds: [...sessionIds] })
  }

  /** The bytes a session keeps under this hash; null when it keeps none. */
  blob(sessionId: string, hash: string): Promise<StoredBlob | null> {
    return this.request({ op: 'blob', sessionId, hash })
  }

  /** Settles once every request made so far is answered, whatever the answer. */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.inflight])
  }

  /** Waits for the requests in flight, folds the WAL into the file and stops the worker. */
  close(): Promise<void> {
    this.closing ??= (async () => {
      if (!this.stopped) {
        const closed = this.request<null>({ op: 'close' }).catch((error: unknown) => {
          this.options.log(
            'warn',
            `Closing the thread database failed: ${(error as Error).message}`,
          )
        })
        let timer: ReturnType<typeof setTimeout> | null = null
        const timeout = new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), this.options.closeTimeoutMs ?? 2_000)
        })
        const outcome = await Promise.race([closed, timeout])
        if (timer) clearTimeout(timer)
        if (outcome === 'timeout') {
          this.options.log('warn', 'The thread database did not close in time; stopping its worker')
        }
      }
      this.stop('The thread store is closed')
      await this.worker.terminate()
    })()
    return this.closing
  }
}
