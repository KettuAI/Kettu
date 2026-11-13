// The host's side of the thread database: a promise API over the thread worker, which owns the
// SQLite file, so no query runs on the event loop that streams the sessions.

import type { Worker } from 'node:worker_threads'
import type { OutlineTitle } from '@shared/agent-host'
import type { ArtifactState } from '@shared/artifacts'
import type { ArtifactCall, ArtifactCallName, ArtifactCalls } from '../artifacts/model'
import type { RuntimeCall, RuntimeCallName, RuntimeCalls } from '../artifacts/runtime/calls'
import type { RoutineCall, RoutineCallName, RoutineCalls } from '../routines/calls'
import type { LogFn } from '../storage'
import type {
  ImageMode,
  StoredBlob,
  StoredOutline,
  StoredThread,
  ThreadPage,
  ThreadWrite,
} from './model'
import type {
  ThreadDbStatus,
  ThreadErrorCode,
  ThreadReply,
  ThreadRequest,
  ThreadWorkerData,
} from './protocol'

/** What the store needs of a worker, so tests can run the service in their own thread. */
export interface ThreadWorker {
  postMessage(request: ThreadRequest): void
  onMessage(listener: (reply: ThreadReply) => void): void
  /** Called once when the worker stops, with the error that stopped it, if any. */
  onExit(listener: (error: Error | null) => void): void
  terminate(): Promise<unknown>
}

export type ThreadWorkerFactory = (data: ThreadWorkerData) => ThreadWorker

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
    readonly data?: ArtifactState,
  ) {
    super(message)
    this.name = 'ThreadStoreError'
  }
}

export interface ThreadStoreOptions {
  file: string
  /** Where artifact versions keep their HTML; without it no artifact can be written. */
  contentDir?: string
  createWorker: ThreadWorkerFactory
  log: LogFn
  /** How long closing waits for the worker to fold the WAL before stopping it. */
  closeTimeoutMs?: number
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never
type Request = WithoutId<ThreadRequest>

/** A worker that stops more often than this within a minute is not started again. */
const MAX_RESTARTS = 3
const RESTART_WINDOW_MS = 60_000

type SlotKind = 'writer' | 'reader'

/** One worker and the requests it has yet to answer. */
interface Slot {
  kind: SlotKind
  worker: ThreadWorker
  pending: Map<number, Pending>
  /** How the database opened in it; `unavailable` when it never got that far. */
  ready: Promise<ThreadDbStatus>
  /** Replaced or stopped by the store, so its exit is no failure. */
  retired: boolean
}

/**
 * Two workers own the file: the writer, which every write and full load goes to, and a reader
 * beside it, so a page read never waits behind them. A read of a session waits only for that
 * session's writes in flight, so it sees them. A worker that stops is started again.
 */
export class ThreadStore {
  /** How the database opened; `unavailable` when the worker never got that far. */
  readonly ready: Promise<ThreadDbStatus>
  private writer: Slot
  /** The reader once it opened the file; until then, and without one, the writer reads. */
  private reader: Slot | null = null
  /** Counts the reader's starts, so only the latest becomes the reader. */
  private readerStarts = 0
  private readonly restarts: Record<SlotKind, number[]> = { writer: [], reader: [] }
  private readonly inflight = new Set<Promise<unknown>>()
  /** Each session's writes in flight, which a read of the session waits for. */
  private readonly writes = new Map<string, Set<Promise<unknown>>>()
  private nextId = 1
  /** Why requests fail at once: the writer stopped for good, or the store closed. */
  private stopped: string | null = null
  private closing: Promise<void> | null = null

  constructor(private readonly options: ThreadStoreOptions) {
    this.writer = this.spawn('writer')
    this.ready = this.writer.ready
    void this.startReader()
  }

  private spawn(kind: SlotKind): Slot {
    let settleReady: (status: ThreadDbStatus) => void = () => {}
    const ready = new Promise<ThreadDbStatus>((resolve) => {
      settleReady = resolve
    })
    const { file, contentDir } = this.options
    const worker = this.options.createWorker(
      kind === 'writer'
        ? { file, contentDir: contentDir ?? null }
        : { file, contentDir: null, reader: true },
    )
    const slot: Slot = { kind, worker, pending: new Map(), ready, retired: false }
    worker.onMessage((reply) => {
      switch (reply.type) {
        case 'ready':
          settleReady(reply.status)
          break
        case 'recovered':
          // The reader still has the damaged file open.
          this.restartReader()
          break
        case 'log':
          this.options.log(reply.level, `Thread database: ${reply.message}`)
          break
        case 'result':
          this.settle(slot, reply.id)?.resolve(reply.value)
          break
        case 'error':
          this.settle(slot, reply.id)?.reject(
            new ThreadStoreError(reply.message, reply.code, reply.data),
          )
          break
      }
    })
    worker.onExit((error) => {
      settleReady('unavailable')
      if (slot.retired || this.closing) return
      this.exited(slot, error)
    })
    return slot
  }

  /** Starts the reader once the writer has the file at this version, which it then opens. */
  private async startReader(): Promise<void> {
    const start = ++this.readerStarts
    const writer = this.writer
    const status = await writer.ready
    if (status !== 'ok' && status !== 'created' && status !== 'recovered') return
    if (this.closing || this.stopped || start !== this.readerStarts) return
    const slot = this.spawn('reader')
    const opened = await slot.ready
    if (
      opened !== 'ok' ||
      this.closing ||
      this.stopped ||
      slot.retired ||
      start !== this.readerStarts
    ) {
      this.retire(slot)
      return
    }
    this.reader = slot
  }

  private restartReader(): void {
    if (this.reader) this.retire(this.reader)
    this.reader = null
    void this.startReader()
  }

  private retire(slot: Slot): void {
    slot.retired = true
    this.fail(slot, new ThreadStoreError('The thread reader was replaced', 'unavailable'))
    void slot.worker.terminate()
  }

  /** A worker stopped on its own: its requests fail, and it starts again unless it keeps stopping. */
  private exited(slot: Slot, error: Error | null): void {
    slot.retired = true
    const reason = `The thread ${slot.kind} stopped${error ? `: ${error.message}` : ''}`
    this.options.log('error', reason)
    this.fail(slot, new ThreadStoreError(reason, 'unavailable'))
    const now = Date.now()
    const recent = this.restarts[slot.kind].filter((at) => now - at < RESTART_WINDOW_MS)
    if (recent.length >= MAX_RESTARTS) {
      this.options.log('error', `The thread ${slot.kind} keeps stopping; it is not started again`)
      if (slot.kind === 'writer') this.stop(reason)
      else if (this.reader === slot) this.reader = null
      return
    }
    this.restarts[slot.kind] = [...recent, now]
    this.options.log('warn', `Starting the thread ${slot.kind} again`)
    if (slot.kind === 'writer') {
      this.writer = this.spawn('writer')
      if (!this.reader) void this.startReader()
    } else {
      this.restartReader()
    }
  }

  private settle(slot: Slot, id: number): Pending | undefined {
    const pending = slot.pending.get(id)
    slot.pending.delete(id)
    return pending
  }

  private fail(slot: Slot, error: ThreadStoreError): void {
    for (const pending of slot.pending.values()) pending.reject(error)
    slot.pending.clear()
  }

  private stop(reason: string): void {
    this.stopped = reason
    const error = new ThreadStoreError(reason, 'unavailable')
    this.fail(this.writer, error)
    if (this.reader) this.fail(this.reader, error)
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    const done = (): void => {
      this.inflight.delete(promise)
    }
    this.inflight.add(promise)
    promise.then(done, done)
    return promise
  }

  private send<T>(slot: Slot, request: Request): Promise<T> {
    if (this.stopped) return Promise.reject(new ThreadStoreError(this.stopped, 'unavailable'))
    const id = this.nextId++
    const promise = new Promise<T>((resolve, reject) => {
      slot.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
    })
    slot.worker.postMessage({ ...request, id } as ThreadRequest)
    return promise
  }

  /** A request of the writer, in the order of the others. */
  private request<T>(request: Request): Promise<T> {
    return this.track(this.send<T>(this.writer, request))
  }

  /** A write of these sessions, which their reads wait for. */
  private sessionWrite<T>(request: Request, sessionIds: readonly string[]): Promise<T> {
    const promise = this.request<T>(request)
    for (const sessionId of sessionIds) {
      let writes = this.writes.get(sessionId)
      if (!writes) this.writes.set(sessionId, (writes = new Set()))
      writes.add(promise)
    }
    const done = (): void => {
      for (const sessionId of sessionIds) {
        const writes = this.writes.get(sessionId)
        writes?.delete(promise)
        if (writes?.size === 0) this.writes.delete(sessionId)
      }
    }
    promise.then(done, done)
    return promise
  }

  /** A read of a session, by the reader after the session's writes in flight. */
  private read<T>(request: Request, sessionId: string): Promise<T> {
    const writes = this.writes.get(sessionId)
    const read = async (): Promise<T> => {
      if (writes) await Promise.allSettled([...writes])
      const reader = this.reader
      if (!reader) return this.send<T>(this.writer, request)
      try {
        return await this.send<T>(reader, request)
      } catch (error) {
        // The writer answers what the reader could not: it recovers a damaged file.
        const code = error instanceof ThreadStoreError ? error.code : null
        if (code !== 'unavailable' && code !== 'corrupt') throw error
        return this.send<T>(this.writer, request)
      }
    }
    return this.track(read())
  }

  /**
   * The page ending below `before`, or the latest page; with `from`, reaching back to the turn
   * holding it. Null when the session has no thread. Its images are references unless `images`
   * says `inline`.
   */
  page(
    sessionId: string,
    before: number | null = null,
    from: number | null = null,
    images: ImageMode = 'refs',
  ): Promise<ThreadPage | null> {
    return this.read({ op: 'page', sessionId, before, from, images }, sessionId)
  }

  /** Everything from `from` on; null when the session has no thread. */
  tail(sessionId: string, from: number, images: ImageMode = 'refs'): Promise<ThreadPage | null> {
    return this.read({ op: 'tail', sessionId, from, images }, sessionId)
  }

  /** The whole thread; null when the session has none, or part of it does not parse. */
  load(sessionId: string): Promise<StoredThread | null> {
    return this.request({ op: 'load', sessionId })
  }

  write(sessionId: string, change: ThreadWrite): Promise<void> {
    return this.sessionWrite({ op: 'write', sessionId, change }, [sessionId])
  }

  remove(sessionIds: readonly string[]): Promise<void> {
    return this.sessionWrite({ op: 'remove', sessionIds: [...sessionIds] }, sessionIds)
  }

  /** The bytes a session keeps under this hash; null when it keeps none. */
  blob(sessionId: string, hash: string): Promise<StoredBlob | null> {
    return this.read({ op: 'blob', sessionId, hash }, sessionId)
  }

  /** Whether an agent or user entry of the stored thread holds `text`. */
  mentions(sessionId: string, text: string): Promise<boolean> {
    return this.read({ op: 'mentions', sessionId, text }, sessionId)
  }

  /** The user messages of the stored thread, with their titles; null when it has none. */
  outline(sessionId: string): Promise<StoredOutline | null> {
    return this.read({ op: 'outline', sessionId }, sessionId)
  }

  /** Stores outline titles; false when the session has no stored thread to keep them with. */
  setOutlineTitles(sessionId: string, titles: OutlineTitle[]): Promise<boolean> {
    return this.sessionWrite({ op: 'setOutlineTitles', sessionId, titles }, [sessionId])
  }

  /** A call on the artifact records, which share the database. */
  artifact<K extends ArtifactCallName>(
    name: K,
    params: ArtifactCalls[K]['params'],
  ): Promise<ArtifactCalls[K]['result']> {
    // TypeScript cannot pair a generic name with its params inside the union.
    return this.request({ op: 'artifact', call: { name, params } as ArtifactCall })
  }

  /** A call on the artifacts' declarations, data and consents, which share the database. */
  runtime<K extends RuntimeCallName>(
    name: K,
    params: RuntimeCalls[K]['params'],
  ): Promise<RuntimeCalls[K]['result']> {
    return this.request({ op: 'runtime', call: { name, params } as RuntimeCall })
  }

  /** A call on the routine runs, which share the database. */
  routine<K extends RoutineCallName>(
    name: K,
    params: RoutineCalls[K]['params'],
  ): Promise<RoutineCalls[K]['result']> {
    return this.request({ op: 'routine', call: { name, params } as RoutineCall })
  }

  /** Settles once every request made so far is answered, whatever the answer. */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.inflight])
  }

  /** Waits for the requests in flight, folds the WAL into the file and stops the workers. */
  close(): Promise<void> {
    this.closing ??= (async () => {
      const reader = this.reader
      this.reader = null
      if (!this.stopped) {
        // The reader closes first, so the writer folds the whole WAL into the file.
        if (reader) await this.closeSlot(reader)
        await this.closeSlot(this.writer)
      }
      this.stop('The thread store is closed')
      if (reader)
        this.fail(reader, new ThreadStoreError('The thread store is closed', 'unavailable'))
      await Promise.all([this.writer.worker.terminate(), reader?.worker.terminate()])
    })()
    return this.closing
  }

  private async closeSlot(slot: Slot): Promise<void> {
    const closed = this.send<null>(slot, { op: 'close' }).catch((error: unknown) => {
      this.options.log('warn', `Closing the thread database failed: ${(error as Error).message}`)
    })
    let timer: ReturnType<typeof setTimeout> | null = null
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.options.closeTimeoutMs ?? 2_000)
    })
    const outcome = await Promise.race([closed, timeout])
    if (timer) clearTimeout(timer)
    if (outcome === 'timeout') {
      this.options.log('warn', `The thread ${slot.kind} did not close in time; stopping it`)
    }
  }
}
