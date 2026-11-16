// When an idle Claude Code session lets its agent go, as each host's Settings › Agents › Idle
// sessions sets it, and the rule in force that the host tells its clients.

/** By the system's memory, by the user's own values, or never for idleness. */
export const IDLE_RELEASE_MODES = ['auto', 'custom', 'never'] as const
export type IdleReleaseMode = (typeof IDLE_RELEASE_MODES)[number]

/** Custom's minutes after a session leaves view. */
export const OUT_OF_VIEW_MINUTES = [1, 5, 15, 30, 60] as const
/** Custom's minutes idle in view. */
export const IN_VIEW_MINUTES = [5, 15, 30, 60] as const
/** Custom's most idle processes kept; null for no limit. */
export const IDLE_LIMITS = [null, 1, 2, 3, 5] as const

export interface IdleSessionsSettings {
  release: IdleReleaseMode
  outOfView: (typeof OUT_OF_VIEW_MINUTES)[number]
  inView: (typeof IN_VIEW_MINUTES)[number]
  limit: (typeof IDLE_LIMITS)[number]
}

/** The system's memory as the host last read it: unknown when it could not be read. */
export type MemoryState = 'plenty' | 'tight' | 'critical' | 'unknown'

/** What idle Claude Code sessions follow now, in minutes. */
export interface IdleReleaseRule {
  outOfView: number
  inView: number
  /** The most idle processes kept, the least recently used going first; null for no limit. */
  limit: number | null
  /** Memory is critical: every idle session lets its agent go at once. */
  now: boolean
}

export interface IdleReleaseState {
  memory: MemoryState
  /** Null under Never. */
  rule: IdleReleaseRule | null
  /**
   * Claude Code versions whose resumes lost the prompt cache twice in a row: their sessions keep
   * their agent until the cache expires, over the rule, unless memory is critical.
   */
  fallback: string[]
}
