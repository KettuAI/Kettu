import type { PlanLimit } from '@shared/agent-host'
import { i18n } from '@renderer/lib/i18n'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * The window to show for an agent: a reached one first, then the fullest. A window whose reset
 * time has passed is skipped, because its percentage is from before the reset.
 */
export function tightestLimit(limits: readonly PlanLimit[], now: number): PlanLimit | null {
  const current = limits.filter((l) => l.resetsAt === null || l.resetsAt > now)
  const reached = current.find((l) => l.state === 'reached')
  if (reached) return reached
  const known = current.filter((l) => l.usedPercent !== null)
  const fullest = known.sort((a, b) => (b.usedPercent ?? 0) - (a.usedPercent ?? 0))[0]
  return fullest ?? current[0] ?? null
}

export type UsageTone = 'success' | 'attention' | 'destructive'

/**
 * A window's usage level, as the design system's usage levels give it: plenty below 60% used,
 * getting close from 60%, nearly gone from 90% or once the limit is reached.
 */
export function usageTone(limit: Pick<PlanLimit, 'usedPercent' | 'state'>): UsageTone {
  const used = limit.usedPercent ?? 0
  if (limit.state === 'reached' || used >= 90) return 'destructive'
  if (used >= 60) return 'attention'
  return 'success'
}

/** A percentage's text color at each usage level; with plenty left it keeps its own. */
export const USAGE_TONE_TEXT: Record<UsageTone, string> = {
  success: '',
  attention: 'text-attention-text',
  destructive: 'text-destructive',
}

/** Time left in its two largest units: "42m", "5h 12m", "1d 5h"; null once it has passed. */
export function countdown(ms: number): string | null {
  if (ms <= 0) return null
  if (ms < HOUR) {
    return i18n.t('sidebar:countdown.minutes', { count: Math.max(1, Math.floor(ms / MINUTE)) })
  }
  if (ms < DAY) {
    const hours = Math.floor(ms / HOUR)
    const minutes = Math.floor((ms % HOUR) / MINUTE)
    return minutes
      ? i18n.t('sidebar:countdown.hoursMinutes', { hours, minutes })
      : i18n.t('sidebar:countdown.hours', { count: hours })
  }
  const days = Math.floor(ms / DAY)
  const hours = Math.floor((ms % DAY) / HOUR)
  return hours
    ? i18n.t('sidebar:countdown.daysHours', { days, hours })
    : i18n.t('sidebar:countdown.days', { count: days })
}
