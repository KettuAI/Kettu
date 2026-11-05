import type { PlanLimit } from '@shared/agent-host'

/** How full a plan limit is: under 70% used, 70 to 89%, or 90% and over. */
export type LimitLevel = 'ok' | 'warn' | 'bad'

/**
 * A plan limit's level, which colors its bar wherever one is shown. It goes by the whole
 * percentage the bar shows beside it, so "90%" never sits next to a yellow bar.
 */
export function limitLevel(limit: Pick<PlanLimit, 'usedPercent' | 'state'>): LimitLevel {
  if (limit.state === 'reached') return 'bad'
  const used = Math.round(limit.usedPercent ?? 0)
  if (used >= 90) return 'bad'
  if (used >= 70) return 'warn'
  return 'ok'
}

/** A limit bar's fill at each level. */
export const LIMIT_FILL: Record<LimitLevel, string> = {
  ok: 'bg-limit-ok',
  warn: 'bg-limit-warn',
  bad: 'bg-limit-bad',
}

/** A limit ring's color at each level, drawn with `currentColor`. */
export const LIMIT_STROKE: Record<LimitLevel, string> = {
  ok: 'text-limit-ok',
  warn: 'text-limit-warn',
  bad: 'text-limit-bad',
}

/** A limit's percentage at each level: the bar colors are too light for text. */
export const LIMIT_TEXT: Record<LimitLevel, string> = {
  ok: 'text-tertiary',
  warn: 'text-warning',
  bad: 'text-danger',
}
