// The routines' scheduler: one timer, recomputed from the wall clock, that starts due runs.

import { nextRuns, occurrencesBetween } from '@shared/schedule'
import type { Schedule } from '@shared/routines'

export interface RoutineClock {
  now(): number
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const SYSTEM_CLOCK: RoutineClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms)
    handle.unref?.()
    return handle
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** The longest the timer waits, so a clock change or a sleep is seen within a minute. */
const MAX_DELAY = 60_000

export interface SchedulerRoutine {
  id: string
  schedule: Schedule
  enabled: boolean
  checkedThrough: number
}

export interface SchedulerDeps {
  clock: RoutineClock
  routines(): readonly SchedulerRoutine[]
  /**
   * A scheduled time came due. `trigger` is catch-up when `count` times were missed, and `at`
   * is the first of them.
   */
  due(routineId: string, at: number, trigger: 'schedule' | 'catch-up', count: number): void
  /** Every scheduled time up to `at` is accounted for: run, skipped or caught up. */
  accounted(routineId: string, at: number): void
}

export class RoutineScheduler {
  private timer: unknown = null
  private started = false
  private first = true
  private gapped = false

  constructor(private readonly deps: SchedulerDeps) {}

  start(): void {
    if (this.started) return
    this.started = true
    this.first = true
    this.evaluate()
  }

  stop(): void {
    this.started = false
    this.clear()
  }

  /** Recomputes the timer after a routine was added, changed, removed or ran. */
  refresh(): void {
    if (!this.started) return
    this.arm()
  }

  power(state: 'suspend' | 'resume'): void {
    if (!this.started) return
    this.gapped = true
    if (state === 'suspend') this.clear()
    else this.evaluate()
  }

  /** The next scheduled time after now, or null while off, done or beyond the horizon. */
  nextRunAt(routine: SchedulerRoutine, now = this.deps.clock.now()): number | null {
    if (!routine.enabled) return null
    const after = Math.max(routine.checkedThrough, now)
    return nextRuns(routine.schedule, after, { count: 1 })[0]?.at ?? null
  }

  private evaluate(): void {
    this.clear()
    if (!this.started) return
    const now = this.deps.clock.now()
    // The first pass after start, and the one after a sleep, may find more than a tick's worth.
    const gap = this.first || this.gapped
    this.first = false
    this.gapped = false
    for (const routine of this.deps.routines()) {
      if (!routine.enabled) continue
      const span = occurrencesBetween(routine.schedule, routine.checkedThrough, now)
      if (!span) continue
      const missed = gap || span.count > 1
      this.deps.accounted(routine.id, span.last.at)
      this.deps.due(routine.id, span.first.at, missed ? 'catch-up' : 'schedule', span.count)
    }
    this.arm()
  }

  private arm(): void {
    this.clear()
    if (!this.started) return
    const now = this.deps.clock.now()
    let next: number | null = null
    for (const routine of this.deps.routines()) {
      if (!routine.enabled) continue
      const after = Math.max(routine.checkedThrough, now)
      const run = nextRuns(routine.schedule, after, { count: 1 })[0]
      if (run && (next === null || run.at < next)) next = run.at
    }
    const delay = next === null ? MAX_DELAY : Math.max(0, Math.min(next - now, MAX_DELAY))
    this.timer = this.deps.clock.setTimeout(() => {
      this.timer = null
      this.evaluate()
    }, delay)
  }

  private clear(): void {
    if (this.timer === null) return
    this.deps.clock.clearTimeout(this.timer)
    this.timer = null
  }
}
