import type { PlanLimit } from '@shared/agent-host'
import { currentLocale, i18n } from './i18n'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

// Formatters are costly to build, so each is made once per language. A component that shows
// their output re-renders on a language change through its own `useTranslation()`.
const formatters = new Map<string, ReturnType<typeof makeFormatters>>()

function makeFormatters(locale: string) {
  return {
    weekday: new Intl.DateTimeFormat(locale, { weekday: 'short' }),
    monthDay: new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }),
    clock: new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }),
    full: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }),
    compact: new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }),
    integer: new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }),
    percent: new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }),
  }
}

function format(): ReturnType<typeof makeFormatters> {
  const locale = currentLocale()
  let made = formatters.get(locale)
  if (!made) formatters.set(locale, (made = makeFormatters(locale)))
  return made
}

/** A compact relative time for lists: "now", "4m", "2h", "Mon", "Oct 3". */
export function shortAgo(at: number, now = Date.now()): string {
  const delta = Math.max(0, now - at)
  if (delta < MINUTE) return i18n.t('time.now')
  if (delta < HOUR) return i18n.t('time.minutesShort', { count: Math.floor(delta / MINUTE) })
  if (delta < DAY) return i18n.t('time.hoursShort', { count: Math.floor(delta / HOUR) })
  if (delta < 7 * DAY) return format().weekday.format(at)
  return format().monthDay.format(at)
}

/** A relative time for sentences: "just now", "5 minutes ago", "2 hours ago", "on Oct 3". */
export function longAgo(at: number, now = Date.now()): string {
  const delta = Math.max(0, now - at)
  if (delta < MINUTE) return i18n.t('time.justNow')
  if (delta < HOUR) return i18n.t('time.minutesAgo', { count: Math.floor(delta / MINUTE) })
  if (delta < DAY) return i18n.t('time.hoursAgo', { count: Math.floor(delta / HOUR) })
  if (delta < 2 * DAY) return i18n.t('time.yesterday')
  return i18n.t('time.onDate', { date: format().monthDay.format(at) })
}

/** When a limit resets: the clock time today, the weekday within six days, the date beyond. */
export function resetTime(at: number, now = Date.now()): string {
  const day = (t: number): number => new Date(t).setHours(0, 0, 0, 0)
  // Rounded, since a day across a DST change is not 24 hours.
  const days = Math.round((day(at) - day(now)) / DAY)
  if (days === 0) return format().clock.format(at)
  return days <= 6 ? format().weekday.format(at) : format().monthDay.format(at)
}

export function fullTime(at: number): string {
  return format().full.format(at)
}

/** "2 m 13 s", "48 s", "1 h 5 m". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return i18n.t('time.seconds', { s })
  const m = Math.floor(s / 60)
  if (m < 60) return i18n.t('time.minutesSeconds', { m, s: s % 60 })
  return i18n.t('time.hoursMinutes', { h: Math.floor(m / 60), m: m % 60 })
}

/** A plan-limit window's name: OverBench's for the windows it knows, else the agent's own. */
export function limitLabel(limit: Pick<PlanLimit, 'window' | 'label'>): string {
  const key = `planWindow.${limit.window}`
  if (i18n.exists(key)) return i18n.t(key as 'planWindow.five_hour')
  // Claude Code names a weekly limit per model, "Weekly · Fable", in English.
  const weekly = /^Weekly · (.+)$/.exec(limit.label)
  return weekly ? i18n.t('planWindow.weeklyOf', { model: weekly[1] }) : limit.label
}

/** Token counts everywhere: "980", "41K", "1.2M", "41.7B"; in Chinese, in its own wan and yi. */
export function tokens(n: number): string {
  return format().compact.format(n)
}

/** A count in full, for tables and tooltips: "35,317,988,871". */
export function exactCount(n: number): string {
  return format().integer.format(n)
}

/** A share as a percentage with one decimal: "98.5%". */
export function percent(share: number): string {
  return format().percent.format(share)
}

/** "812 B", "41 kB", "1.2 MB", in the locale's number format. */
export function bytes(n: number): string {
  const [value, unit] =
    n < 1000 ? [n, 'byte'] : n < 1_000_000 ? [n / 1000, 'kilobyte'] : [n / 1_000_000, 'megabyte']
  return new Intl.NumberFormat(currentLocale(), {
    style: 'unit',
    unit,
    unitDisplay: 'short',
    maximumFractionDigits: n < 1000 ? 0 : 1,
  }).format(value)
}

export function money(amount: number, currency: string): string {
  return new Intl.NumberFormat(currentLocale(), { style: 'currency', currency }).format(amount)
}

/** The last part of a path, for either separator. */
export function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return i < 0 ? trimmed : trimmed.slice(i + 1)
}

/** The folder part of a path, with its trailing separator, or "". */
export function dirname(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return i < 0 ? '' : path.slice(0, i + 1)
}

/** A path relative to the project when it is inside it. */
export function relativePath(path: string, projectPath: string): string {
  const root = projectPath.replace(/[\\/]+$/, '')
  if (path === root) return basename(path)
  if (path.startsWith(root + '/') || path.startsWith(root + '\\'))
    return path.slice(root.length + 1)
  return path
}
