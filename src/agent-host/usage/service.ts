// The usage worker's work, apart from the worker itself so tests can run it in their own thread.
// Requests are answered in order; a scan runs in the background, so queries keep being answered
// while the logs are read.

import type { ScanProgress } from '@shared/usage'
import { UsageDb } from './db'
import type { LogReader, ScanContext } from './model'
import type { ScanRequest, ScanResult, UsageReply, UsageRequest } from './protocol'

/** How often progress notices go out while a scan writes. */
export const NOTICE_MS = 200
/**
 * How often change notices do. Each has an open usage page read its figures again, which takes
 * the worker 100-200 ms on a year of logs, so more often would slow the scan it reports on.
 */
export const CHANGE_MS = 1000

export interface ScanOutcome {
  results: ScanResult[]
  cancelled: boolean
}

/** Calls `run` at most once per `ms`, the last call coming through. */
function throttle(run: () => void, ms: number): { call(): void; flush(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  let last = 0
  const fire = (): void => {
    timer = null
    last = Date.now()
    run()
  }
  return {
    call() {
      if (timer) return
      const wait = last + ms - Date.now()
      if (wait <= 0) fire()
      else timer = setTimeout(fire, wait)
    },
    flush() {
      if (!timer) return
      clearTimeout(timer)
      fire()
    },
  }
}

export function startUsageService(
  file: string,
  readers: readonly LogReader[],
  reply: (message: UsageReply) => void,
  now?: () => number,
): (request: UsageRequest) => void {
  const log = (level: 'info' | 'warn' | 'error', message: string): void =>
    reply({ type: 'log', level, message })
  let db: UsageDb | null = null
  try {
    db = UsageDb.open(file, log, now)
    reply({ type: 'ready', status: db.open ? db.status : 'newer' })
  } catch (error) {
    log('error', `Could not open the usage database: ${(error as Error).message}`)
    reply({ type: 'ready', status: 'unavailable' })
  }

  const changed = throttle(() => reply({ type: 'changed' }), CHANGE_MS)
  let progress: ScanProgress | null = null
  const progressed = throttle(() => reply({ type: 'progress', progress }), NOTICE_MS)
  let scanning: AbortController | null = null
  // Scans run one after another; a request during one waits for it.
  let queue: Promise<unknown> = Promise.resolve()

  async function scan(store: UsageDb, request: ScanRequest): Promise<ScanOutcome> {
    const controller = new AbortController()
    scanning = controller
    progress = { files: 0, bytes: 0, doneFiles: 0, doneBytes: 0 }
    progressed.call()
    const results: ScanResult[] = []
    let cancelled = false
    try {
      for (const agentId of request.agents) {
        const reader = readers.find((r) => r.agentId === agentId)
        if (!reader) continue
        const context: ScanContext = {
          env: request.env,
          home: request.home,
          platform: request.platform,
          signal: controller.signal,
          cursor: (id) => store.cursor(id),
          commit: (rows, cursor) => {
            if (store.write(rows, cursor) > 0) changed.call()
          },
          plan: (files, bytes) => {
            progress!.files += files
            progress!.bytes += bytes
            progressed.call()
          },
          done: (bytes) => {
            progress!.doneFiles++
            progress!.doneBytes += bytes
            progressed.call()
          },
          log: (level, message) => log(level, `${agentId}: ${message}`),
        }
        try {
          results.push({ agentId, found: await reader.scan(context), error: null })
        } catch (error) {
          if (controller.signal.aborted) {
            cancelled = true
            break
          }
          const message = (error as Error)?.message ?? String(error)
          log('warn', `Reading ${agentId}'s logs failed: ${message}`)
          results.push({ agentId, found: true, error: message })
        }
      }
    } finally {
      scanning = null
      progress = null
      changed.flush()
      progressed.call()
      progressed.flush()
    }
    return { results, cancelled }
  }

  return (request) => {
    const answer = (run: () => unknown): void => {
      try {
        reply({ type: 'result', id: request.id, value: run() })
      } catch (error) {
        reply({ type: 'error', id: request.id, message: (error as Error).message })
      }
    }
    if (request.op === 'cancel') {
      scanning?.abort()
      answer(() => null)
      return
    }
    if (!db || !db.open) {
      if (request.op === 'close') {
        answer(() => null)
        return
      }
      reply({ type: 'error', id: request.id, message: 'The usage database is not open' })
      return
    }
    const store = db
    switch (request.op) {
      case 'scan':
      case 'removeLogs': {
        // Both wait for the scan in progress, so a re-import never races the reader it resets.
        const run =
          request.op === 'scan'
            ? () => scan(store, request)
            : async () => {
                store.removeLogs(request.agentId)
                changed.call()
                return null
              }
        queue = queue.then(run, run).then(
          (value) => reply({ type: 'result', id: request.id, value }),
          (error: unknown) =>
            reply({ type: 'error', id: request.id, message: (error as Error).message }),
        )
        return
      }
      case 'write':
        answer(() => {
          const count = store.write(request.rows)
          if (count > 0) changed.call()
          return count
        })
        return
      case 'summary':
        answer(() => store.summary(request.dayStarts, request.from, request.to, request.sources))
        return
      case 'totals':
        answer(() => store.totals(request.from, request.to, request.sources))
        return
      case 'stats':
        answer(() => store.stats())
        return
      case 'clearRecord':
        answer(() => {
          store.clearRecord()
          changed.call()
          return null
        })
        return
      case 'close':
        scanning?.abort()
        answer(() => {
          store.close()
          return null
        })
        return
    }
  }
}
