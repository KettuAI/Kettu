import type { PlanLimit } from '@shared/agent-host'
import { resetTime } from '@renderer/lib/format'
import { i18n } from '@renderer/lib/i18n'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

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

/**
 * When a plan window resets, worded the same on every surface: the time left within a day,
 * "Resets in 3h 26m", else when, "Resets Sat 5:00 AM".
 */
export function planReset(at: number, now = Date.now()): string {
  const left = at - now
  return left > 0 && left < DAY
    ? i18n.t('planReset.in', { time: countdown(left) })
    : i18n.t('planReset.at', { time: resetTime(at, now) })
}

/** 紧凑重置时间（不带“Resets”词头）：24 小时内显示剩余倒计时，否则显示重置时刻；已过期返回 null */
export function planResetShort(at: number, now = Date.now()): string | null {
  const left = at - now
  if (left <= 0) return null
  return left < DAY ? countdown(left) : resetTime(at, now)
}
