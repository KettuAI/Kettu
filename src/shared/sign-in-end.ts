// When a stored subscription sign-in ends. Claude Code gives the latest it is expected to end;
// the real end can come up to 3 days sooner, and the date passing means it probably ended.

const DAY = 24 * 60 * 60_000

/** How much sooner than its date a sign-in can end. */
export const SIGN_IN_END_SPREAD_MS = 3 * DAY

/** How long before the earliest end the reminders start. */
export const SIGN_IN_REMIND_MS = 3 * DAY

/** `later` before the reminders start, `soon` from then until the date, `ended` once it passed. */
export type SignInEndPhase = 'later' | 'soon' | 'ended'

export interface SignInEnd {
  latest: number
  earliest: number
  phase: SignInEndPhase
}

export function signInEnd(latest: number, now: number): SignInEnd {
  const earliest = latest - SIGN_IN_END_SPREAD_MS
  const phase: SignInEndPhase =
    now >= latest ? 'ended' : now >= earliest - SIGN_IN_REMIND_MS ? 'soon' : 'later'
  return { latest, earliest, phase }
}

/** An ISO 8601 instant in ms, or null for anything else. */
export function instantOf(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null
  const at = Date.parse(value)
  return Number.isFinite(at) ? at : null
}
