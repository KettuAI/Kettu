import { i18n } from '@renderer/lib/i18n'
import { daysBefore, monthDay } from '@renderer/lib/format'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** A relative time inside a line: "just now", "12 min ago", "2 h ago", "yesterday", "on Oct 3". */
export function ago(at: number, now = Date.now()): string {
  const delta = Math.max(0, now - at)
  if (delta < MINUTE) return i18n.t('tray:ago.justNow')
  if (delta < HOUR) return i18n.t('tray:ago.minutes', { count: Math.floor(delta / MINUTE) })
  if (daysBefore(at, now) === 0)
    return i18n.t('tray:ago.hours', { count: Math.floor(delta / HOUR) })
  if (daysBefore(at, now) === 1) return i18n.t('tray:ago.yesterday')
  return i18n.t('tray:ago.onDate', { date: monthDay(at) })
}

/** The same time on its own line: "Just now", "12 min ago", "2 h ago", "Yesterday", "Oct 3". */
export function when(at: number, now = Date.now()): string {
  const delta = Math.max(0, now - at)
  if (delta < MINUTE) return i18n.t('tray:when.justNow')
  if (delta < HOUR) return i18n.t('tray:when.minutes', { count: Math.floor(delta / MINUTE) })
  if (daysBefore(at, now) === 0)
    return i18n.t('tray:when.hours', { count: Math.floor(delta / HOUR) })
  if (daysBefore(at, now) === 1) return i18n.t('tray:when.yesterday')
  return monthDay(at)
}
