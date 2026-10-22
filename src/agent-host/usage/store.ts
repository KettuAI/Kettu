// The host's side of the usage database: a promise API over the usage worker.

import type { Worker } from 'node:worker_threads'
import type { AgentId } from '@shared/thread'
import type { ScanProgress, TokenParts } from '@shared/usage'
import type { LogFn } from '../storage'
import type { DbSummary, SourceMap, SourceStats, UsageDbStatus } from './db'
import type { UsageRow } from './model'
import type { ScanRequest, UsageReply, UsageRequest } from './protocol'
import type { ScanOutcome } from './service'

/** What the store needs of a worker, so tests can run the service in their own thread. */
export interface UsageWorker {
  postMessage(request: UsageRequest): void
  onMessage(listener: (reply: UsageReply) => void): void
  /** Called once when the worker stops, with the error that stopped it, if any. */
  onExit(listener: (error: Error | null) => void): void
  terminate(): Promise<unknown>
}

export type UsageWorkerFactory = (file: string) => UsageWorker

export function nodeUsageWorker(worker: Worker): UsageWorker {
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

export interface UsageStoreOptions {
  file: string
  createWorker: UsageWorkerFactory
  log: LogFn
  onChanged(): void
  onProgress(progress: ScanProgress | null): void
  /** How long closing waits for the worker to fold the WAL before stopping it. */
  closeTimeoutMs?: number
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never

export class UsageStore {
  /** How the database opened; `unavailable` when the worker never got that far. */
  readonly ready: Promise<UsageDbStatus>
  private readonly worker: UsageWorker
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private stopped: string | null = null
  private closing: Promise<void> | null = null

  constructor(private readonly options: UsageStoreOptions) {
    let settleReady: (status: UsageDbStatus) => void = () => {}
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
          options.log(reply.level, `Usage: ${reply.message}`)
          break
        case 'progress':
          options.onProgress(reply.progress)
          break
        case 'changed':
          options.onChanged()
          break
        case 'result':
          this.settle(reply.id)?.resolve(reply.value)
          break
        case 'error':
          this.settle(reply.id)?.reject(new Error(reply.message))
          break
      }
    })
    this.worker.onExit((error) => {
      settleReady('unavailable')
      if (this.closing) return
      const reason = `The usage worker stopped${error ? `: ${error.message}` : ''}`
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
    for (const pending of this.pending.values()) pending.reject(new Error(reason))
    this.pending.clear()
  }

  private request<T>(request: WithoutId<UsageRequest>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error(this.stopped))
    const id = this.nextId++
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
    })
    this.worker.postMessage({ ...request, id } as UsageRequest)
    return promise
  }

  write(rows: UsageRow[]): Promise<number> {
    return this.request({ op: 'write', rows })
  }

  summary(dayStarts: number[], from: number, to: number, sources: SourceMap): Promise<DbSummary> {
    return this.request({ op: 'summary', dayStarts, from, to, sources })
  }

  totals(
    from: number,
    to: number,
    sources: SourceMap,
  ): Promise<(TokenParts & { agentId: AgentId })[]> {
    return this.request({ op: 'totals', from, to, sources })
  }

  stats(): Promise<SourceStats[]> {
    return this.request({ op: 'stats' })
  }

  /** Reads what is new in the agents' logs; waits for a scan already running. */
  scan(request: ScanRequest): Promise<ScanOutcome> {
    return this.request({ op: 'scan', ...request })
  }

  /** Stops the scan in progress, which then resolves as cancelled. */
  cancel(): Promise<void> {
    return this.request({ op: 'cancel' })
  }

  removeLogs(agentId: AgentId): Promise<void> {
    return this.request({ op: 'removeLogs', agentId })
  }

  clearRecord(): Promise<void> {
    return this.request({ op: 'clearRecord' })
  }

  /** Stops any scan, folds the WAL into the file and stops the worker. */
  close(): Promise<void> {
    this.closing ??= (async () => {
      if (!this.stopped) {
        const closed = this.request<null>({ op: 'close' }).catch((error: unknown) => {
          this.options.log('warn', `Closing the usage database failed: ${(error as Error).message}`)
        })
        let timer: ReturnType<typeof setTimeout> | null = null
        const timeout = new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), this.options.closeTimeoutMs ?? 2_000)
        })
        const outcome = await Promise.race([closed, timeout])
        if (timer) clearTimeout(timer)
        if (outcome === 'timeout') {
          this.options.log('warn', 'The usage database did not close in time; stopping its worker')
        }
      }
      this.stop('The usage store is closed')
      await this.worker.terminate()
    })()
    return this.closing
  }
}
