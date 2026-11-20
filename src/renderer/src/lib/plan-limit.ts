import type { PlanLimit } from '@shared/agent-host'
import type { LimitLevel } from '@shared/plan-limits'

export { limitLevel, type LimitLevel } from '@shared/plan-limits'

/** Whether plan limits show the share used or the share left. */
export type LimitView = 'used' | 'left'

/** The percentage a window shows, from its whole percentage used; used and left add up to 100. */
export function shownPercent(used: number, view: LimitView): number {
  return view === 'left' ? Math.max(0, 100 - used) : used
}

/** A window's percentage as the view shows it; null when the window reports none. */
export function limitPercent(
  limit: Pick<PlanLimit, 'usedPercent'>,
  view: LimitView,
): number | null {
  return limit.usedPercent === null ? null : shownPercent(Math.round(limit.usedPercent), view)
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
