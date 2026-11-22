// Keeps the search index in step with the thread database, in the worker that writes it: each
// committed write is applied at once, and a reconcile finds what the index missed, which is also
// how the first build goes, a session at a time between the worker's other requests.

import type { ThreadWrite } from '../threads/model'
import type { ThreadDb } from '../threads/db'
import { isIndexDamaged, type IndexLog, SearchIndex } from './index'
import { messageChanges } from './messages'

export interface IndexerOptions {
  /** How long after the start the first reconcile waits, so the window comes up first. */
  startDelayMs?: number
  /** How long after a failure the next reconcile waits. */
  retryMs?: number
  /** The rest between two slices of a build. */
  sliceRestMs?: number
  /** Called whenever a reconcile has nothing left to do; for tests. */
  onIdle?: () => void
}

// Positions read from the thread database for one slice: a bounded range, however many of the
// entries in it are tool output, so a slice stays short on a file that is not cached.
const WINDOW = 100
// A build of fewer sessions than this is not announced: it is a few sessions that fell behind.
const ANNOUNCE_FROM = 5

export class Indexer {
  private timer: ReturnType<typeof setTimeout> | null = null
  private working = false
  private again = false
  private stopped = false

  constructor(
    private readonly db: ThreadDb,
    private index: SearchIndex,
    private readonly file: string,
    private readonly log: IndexLog,
    private readonly options: IndexerOptions = {},
  ) {}

  /** The index, for reads while this worker is the one answering. */
  current(): SearchIndex {
    return this.index
  }

  start(): void {
    this.guard(() => {
      // A search before the first reconcile has to know the index is still to be built.
      const stale = this.stale()
      if (stale.length >= ANNOUNCE_FROM) this.index.setBuild({ done: 0, total: stale.length })
    })
    this.schedule(this.options.startDelayMs ?? 3_000)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.index.close()
  }

  /** The mark of a session's thread before a write, which `written` needs. */
  markBefore(sessionId: string): number | null {
    return this.db.threadState(sessionId)?.updatedAt ?? null
  }

  /** Applies a write that was committed; `before` is `markBefore` from just ahead of it. */
  written(sessionId: string, change: ThreadWrite, before: number | null): void {
    this.guard(() => {
      const to = this.db.threadState(sessionId)?.updatedAt
      if (to === undefined) return
      const changes = messageChanges(change.entries)
      if (change.replace) this.index.replace(sessionId, changes.upserts, to)
      else {
        // What an edit from a message set aside is no longer in the conversation.
        const cut = change.cut === undefined ? [] : (change.setAside ?? []).map(({ pos }) => pos)
        const removed = [...changes.removed, ...cut]
        this.index.apply(sessionId, { ...changes, removed }, { from: before, to })
      }
    })
  }

  /** Drops sessions whose threads were removed. */
  removed(sessionIds: readonly string[]): void {
    this.guard(() => this.index.remove(sessionIds))
  }

  /** The thread database was replaced, so what the index holds may be of threads that are gone. */
  recovered(): void {
    this.schedule(0)
  }

  /** Runs `change`, and gives a failure to `failed`: the index is derived, so none is fatal. */
  private guard(change: () => void): void {
    try {
      change()
    } catch (error) {
      this.failed(error)
    }
  }

  private failed(error: unknown): void {
    if (this.stopped) return
    const reason = error instanceof Error ? error.message : String(error)
    if (isIndexDamaged(error)) {
      this.log('warn', `Search index is damaged, built again: ${reason}`)
      try {
        this.index.close()
        SearchIndex.remove(this.file)
        this.index = SearchIndex.open(this.file, this.log)
        this.schedule(0)
        return
      } catch (again) {
        this.log('error', `Could not make the search index again: ${String(again)}`)
      }
    } else {
      this.log('warn', `Search index could not be updated, will be checked again: ${reason}`)
    }
    this.schedule(this.options.retryMs ?? 30_000)
  }

  private schedule(ms: number): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.reconcile()
    }, ms)
    this.timer.unref()
  }

  /**
   * Makes the index match the thread database: drops sessions it no longer has, and reads in
   * those whose mark differs, newest first.
   */
  private async reconcile(): Promise<void> {
    if (this.stopped) return
    if (this.working) {
      this.again = true
      return
    }
    this.working = true
    try {
      do {
        this.again = false
        await this.catchUp()
      } while (this.again && !this.stopped)
    } catch (error) {
      this.failed(error)
    } finally {
      this.working = false
    }
    if (!this.stopped) this.options.onIdle?.()
  }

  private async catchUp(): Promise<void> {
    const stale = this.stale()
    if (stale.length === 0) {
      if (this.index.build()) this.index.setBuild(null)
      return
    }
    const announce = stale.length >= ANNOUNCE_FROM
    if (announce) this.index.setBuild({ done: 0, total: stale.length })
    let done = 0
    for (const sessionId of stale) {
      if (this.stopped) return
      for (const step = this.read(sessionId); !step.next().done;) await this.rest()
      done++
      if (announce) this.index.setBuild({ done, total: stale.length })
      await this.rest()
    }
    if (announce) this.index.setBuild(null)
  }

  /** The sessions whose index is behind their thread, newest first; drops those that are gone. */
  private stale(): string[] {
    const threads = this.db.threadMarks()
    const known = this.index.marks()
    this.index.remove([...known.keys()].filter((id) => !threads.has(id)))
    return [...threads]
      .filter(([id, mark]) => known.get(id) !== mark)
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id)
  }

  /** Reads a session in again, a range of positions at a time. */
  private *read(sessionId: string): Generator<void> {
    const state = this.db.threadState(sessionId)
    if (!state) {
      this.index.remove([sessionId])
      return
    }
    this.index.clear(sessionId)
    for (let from = 0; from < state.nextPos; from += WINDOW) {
      this.index.add(sessionId, this.db.messagesIn(sessionId, from, from + WINDOW))
      if (from + WINDOW < state.nextPos) yield
    }
    // Read after the last range: what was written meanwhile was applied as it came.
    const mark = this.db.threadState(sessionId)?.updatedAt
    if (mark === undefined) this.index.remove([sessionId])
    else this.index.setMark(sessionId, mark)
  }

  private rest(): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, this.options.sliceRestMs ?? 2).unref()
    })
  }
}
