// How far an agent's sessions may go starting sessions of their own through Kettu's session tools:
// a host's setting, which the user can raise or lower in Settings › Agents.

/**
 * By one caller: how many sessions it started may work at once, how many it may start in a local
 * day, and how many reports may wake it since the user last wrote there.
 */
export interface StartedSessionLimits {
  working: number
  daily: number
  reports: number
}

export const STARTED_LIMIT_KEYS = ['working', 'daily', 'reports'] as const
export type StartedLimitKey = (typeof STARTED_LIMIT_KEYS)[number]

export const DEFAULT_STARTED_LIMITS: Readonly<StartedSessionLimits> = {
  working: 3,
  daily: 10,
  reports: 10,
}

export const STARTED_LIMIT_MIN = 1
/** Keeps a typo from lifting a limit for good. */
export const STARTED_LIMIT_MAX = 100

export function isStartedLimit(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= STARTED_LIMIT_MIN &&
    value <= STARTED_LIMIT_MAX
  )
}
