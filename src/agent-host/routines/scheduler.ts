// The routines' scheduler: one timer, recomputed from the wall clock, that starts due runs and
// ends the pauses a plan limit near its end puts on an agent's routines.

import type { PlanLimit } from '@shared/agent-host'
import { nextRuns, occurrencesBetween } from '@shared/schedule'
import type { Schedule } from '@shared/routines'
import type { AgentId } from '@shared/thread'

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

/** A plan-limit window this many percent used, or reached, pauses its agent's routines. */
export const NEAR_LIMIT_PERCENT = 90

/** A pause whose window gives no reset lasts this long, then the limits decide again. */
export const PAUSE_WITHOUT_RESET_MS = 60 * 60_000

/** Limits read longer ago than this are read again before a scheduled run starts. */
export const LIMITS_FRESH_MS = 10 * 60_000

/** An agent's routines, paused while one of its plan-limit windows is near. */
export interface LimitPause {
  agentId: AgentId
  /** Of the near windows, the one that holds the routines longest. */
  limit: PlanLimit
  /** When it began, or went on past its end; a window without a reset holds an hour from it. */
  since: number
  until: number
}

/**
 * How a pause changed: it `began` before a run, a report `changed` its window or `lifted` it, or
 * its time was up, after which it goes on while a window is still near.
 */
export type PauseChange = 'began' | 'changed' | 'lifted' | 'time-up'

export interface SchedulerRoutine {
  id: string
  agentId: AgentId
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
  /** The plan limits the agent reported last. */
  limits(agentId: AgentId): readonly PlanLimit[]
  /** The agent's pause changed; null once it ended. */
  paused(agentId: AgentId, pause: LimitPause | null, change: PauseChange): void
}

export class RoutineScheduler {
  private timer: unknown = null
  private started = false
  private first = true
  private gapped = false
  private readonly pauses = new Map<AgentId, LimitPause>()

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

  /** The next scheduled time after now, or null while off, done, paused or beyond the horizon. */
  nextRunAt(routine: SchedulerRoutine, now = this.deps.clock.now()): number | null {
    if (!routine.enabled || this.pauses.has(routine.agentId)) return null
    const after = Math.max(routine.checkedThrough, now)
    return nextRuns(routine.schedule, after, { count: 1 })[0]?.at ?? null
  }

  pauseOf(agentId: AgentId): LimitPause | null {
    return this.pauses.get(agentId) ?? null
  }

  /**
   * Whether a scheduled run of the agent must wait, by its latest plan limits: its pause, which
   * begins here when a window is near, or null when the run may start.
   */
  check(agentId: AgentId): LimitPause | null {
    const current = this.pauses.get(agentId)
    if (current) return current
    const now = this.deps.clock.now()
    const limit = holdingWindow(this.deps.limits(agentId), now, now)
    if (!limit) return null
    const pause: LimitPause = { agentId, limit, since: now, until: holdUntil(limit, now) }
    this.pauses.set(agentId, pause)
    this.deps.paused(agentId, pause, 'began')
    this.refresh()
    return pause
  }

  /** The agent reported its limits: a pause ends once no window is near, else follows them. */
  limitsChanged(agentId: AgentId): void {
    const current = this.pauses.get(agentId)
    if (!current) return
    const limit = holdingWindow(this.deps.limits(agentId), this.deps.clock.now(), current.since)
    if (!limit) {
      this.pauses.delete(agentId)
      this.deps.paused(agentId, null, 'lifted')
      this.refresh()
      return
    }
    const until = holdUntil(limit, current.since)
    if (sameWindow(limit, current.limit) && until === current.until) return
    const pause: LimitPause = { ...current, limit, until }
    this.pauses.set(agentId, pause)
    this.deps.paused(agentId, pause, 'changed')
    this.refresh()
  }

  private evaluate(): void {
    this.clear()
    if (!this.started) return
    const now = this.deps.clock.now()
    // Times due before a pause ended are skipped, not caught up once it does.
    this.skipPausedSpans(now)
    this.endPauses(now)
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

  /** Accounts for every time an agent's routines had while a pause ended before `now`. */
  private skipPausedSpans(now: number): void {
    for (const pause of [...this.pauses.values()]) {
      if (pause.until > now) continue
      for (const routine of this.deps.routines()) {
        if (!routine.enabled || routine.agentId !== pause.agentId) continue
        // The time at the reset itself is the first that may run.
        const span = occurrencesBetween(routine.schedule, routine.checkedThrough, pause.until - 1)
        if (!span) continue
        this.deps.accounted(routine.id, span.last.at)
        this.deps.due(
          routine.id,
          span.first.at,
          span.count > 1 ? 'catch-up' : 'schedule',
          span.count,
        )
      }
    }
  }

  /** A pause whose time is up goes on only while the latest limits still hold a window near. */
  private endPauses(now: number): void {
    for (const pause of [...this.pauses.values()]) {
      if (pause.until > now) continue
      const limit = holdingWindow(this.deps.limits(pause.agentId), now, now)
      if (!limit) {
        this.pauses.delete(pause.agentId)
        this.deps.paused(pause.agentId, null, 'time-up')
        continue
      }
      const next: LimitPause = {
        agentId: pause.agentId,
        limit,
        since: now,
        until: holdUntil(limit, now),
      }
      this.pauses.set(pause.agentId, next)
      this.deps.paused(pause.agentId, next, 'time-up')
    }
  }

  private arm(): void {
    this.clear()
    if (!this.started) return
    const now = this.deps.clock.now()
    let next: number | null = null
    for (const routine of this.deps.routines()) {
      if (!routine.enabled) continue
      // A paused agent's times still come due, so they are skipped and accounted for.
      const after = Math.max(routine.checkedThrough, now)
      const run = nextRuns(routine.schedule, after, { count: 1 })[0]
      if (run && (next === null || run.at < next)) next = run.at
    }
    for (const pause of this.pauses.values()) {
      if (next === null || pause.until < next) next = pause.until
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

/**
 * Of an agent's windows that are near, reached or at least 90% used, the one that holds its
 * routines longest; null when none is. A window whose reset has passed does not count.
 */
export function holdingWindow(
  limits: readonly PlanLimit[],
  now: number,
  since: number,
): PlanLimit | null {
  let held: PlanLimit | null = null
  for (const limit of limits) {
    if (limit.resetsAt !== null && limit.resetsAt <= now) continue
    const near =
      limit.state === 'reached' ||
      (limit.usedPercent !== null && limit.usedPercent >= NEAR_LIMIT_PERCENT)
    if (!near) continue
    if (!held || holdUntil(limit, since) > holdUntil(held, since)) held = limit
  }
  return held
}

function holdUntil(limit: PlanLimit, since: number): number {
  return limit.resetsAt ?? since + PAUSE_WITHOUT_RESET_MS
}

/** Whether two readings say the same of a window, whenever they were observed. */
function sameWindow(a: PlanLimit, b: PlanLimit): boolean {
  return (
    a.window === b.window &&
    a.label === b.label &&
    a.usedPercent === b.usedPercent &&
    a.resetsAt === b.resetsAt &&
    a.state === b.state
  )
}
