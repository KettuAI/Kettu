import type { AgentStatus, PlanLimit } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
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

/**
 * The agents whose plan limits are worth reading when a surface that lists them opens: added,
 * already running and able to report them, so that no agent starts just for the read.
 */
export function limitReaders(agents: readonly AgentStatus[]): AgentId[] {
  return agents
    .filter(
      (a) => a.registered !== false && !a.disabled && a.state === 'ready' && a.capabilities.reports,
    )
    .map((a) => a.id)
}

export type UsageTone = 'low' | 'medium' | 'high' | 'critical'

/**
 * A usage level, as the context's ring and percentage show it: below 50% used, 50 to 79%, 80 to
 * 94%, and from 95% or once the limit is reached. It goes by the whole percentage shown, so "80%"
 * never sits beside the level below. A plan limit's bar takes limitLevel instead.
 */
export function usageTone(limit: Pick<PlanLimit, 'usedPercent' | 'state'>): UsageTone {
  const used = Math.round(limit.usedPercent ?? 0)
  if (limit.state === 'reached' || used >= 95) return 'critical'
  if (used >= 80) return 'high'
  if (used >= 50) return 'medium'
  return 'low'
}

/** A percentage's text color at each usage level. */
export const USAGE_TONE_TEXT: Record<UsageTone, string> = {
  low: 'text-tertiary',
  medium: 'text-tertiary',
  high: 'text-warning',
  critical: 'text-danger',
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
