import type { SessionSummary } from '@shared/agent-host'

/** The part of the day the greeting names, by local time. */
export type GreetingPeriod = 'morning' | 'afternoon' | 'evening' | 'late'

/** What the heading's line is picked for: the period, or a moment that replaces it. */
export type GreetingMoment = GreetingPeriod | 'first' | 'back' | 'monday' | 'friday' | 'weekend'

const BACK_AFTER = 7 * 24 * 60 * 60 * 1000

export function greetingPeriod(date: Date): GreetingPeriod {
  const hour = date.getHours()
  if (hour >= 5 && hour < 12) return 'morning'
  if (hour >= 12 && hour < 18) return 'afternoon'
  if (hour >= 18 && hour < 23) return 'evening'
  return 'late'
}

/**
 * The moment at `now`, the first that holds: no session started yet, back after a week, late at
 * night, Monday morning, Friday afternoon, the weekend; else the period. `lastStarted` is null when
 * the user never started a session and undefined while the sessions load.
 */
export function greetingMoment(
  now: number,
  lastStarted: number | null | undefined,
): GreetingMoment {
  if (lastStarted === null) return 'first'
  if (lastStarted !== undefined && now - lastStarted >= BACK_AFTER) return 'back'
  const date = new Date(now)
  const period = greetingPeriod(date)
  if (period === 'late') return period
  const day = date.getDay()
  if (day === 1 && period === 'morning') return 'monday'
  if (day === 5 && period === 'afternoon') return 'friday'
  if (day === 0 || day === 6) return 'weekend'
  return period
}

/**
 * When the user last started a session, archived ones included; routine runs, subagents and the
 * prepared session were not started by them. Null for none.
 */
export function lastStartedAt(byId: Record<string, SessionSummary>): number | null {
  let last: number | null = null
  for (const s of Object.values(byId)) {
    if (s.origin !== 'user' || s.prepared) continue
    if (last === null || s.createdAt > last) last = s.createdAt
  }
  return last
}

const lastShown = new Map<string, number>()

/**
 * One of `count` lines for `key`, never the one last shown for it. It only reads, as React may
 * call it twice for one render; `lineShown` records the line once it is on screen.
 */
export function pickLine(key: string, count: number): number {
  const last = lastShown.get(key)
  const skip = last !== undefined && last < count && count > 1 ? last : -1
  const index = Math.floor(Math.random() * (skip < 0 ? count : count - 1))
  return skip >= 0 && index >= skip ? index + 1 : index
}

export function lineShown(key: string, index: number): void {
  lastShown.set(key, index)
}
