// The effort a session keeps when its model changes: the same level when the new model offers it,
// else the nearest lower one it offers, else none, so the new model's own default applies.

import type { ConfigOption } from './thread'

// The levels agents name alike, from least to most.
const EFFORT_ORDER: readonly string[] = [
  'none',
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
]

/**
 * The level of `offered` that `wanted` carries to: itself, or the highest offered level below it.
 * Null when there is none, or `wanted` is not a level Kettu can rank.
 */
export function carriedEffort(offered: readonly string[], wanted: string): string | null {
  if (offered.includes(wanted)) return wanted
  const rank = EFFORT_ORDER.indexOf(wanted)
  if (rank < 0) return null
  let best: string | null = null
  let bestRank = -1
  for (const level of offered) {
    const at = EFFORT_ORDER.indexOf(level)
    if (at >= 0 && at < rank && at > bestRank) {
      best = level
      bestRank = at
    }
  }
  return best
}

/** `carriedEffort` on a model's level option; null for a model that offers none. */
export function carriedLevel(level: ConfigOption | undefined, wanted: string): string | null {
  const offered = level?.type === 'select' ? (level.choices ?? []).map((c) => c.value) : []
  return carriedEffort(offered, wanted)
}
