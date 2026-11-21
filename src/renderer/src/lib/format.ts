import type { PlanLimit } from '@shared/agent-host'
import { windowParts, type WindowParts } from '@shared/plan-limits'
import { currentLocale, i18n } from './i18n'
import { hostPath } from './host-paths'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY

// Formatters are costly to build, so each is made once per language. A component that shows
// their output re-renders on a language change through its own `useTranslation()`.
const formatters = new Map<string, ReturnType<typeof makeFormatters>>()

function makeFormatters(locale: string) {
  return {
    weekdayClock: new Intl.DateTimeFormat(locale, {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
    }),
    weekday: new Intl.DateTimeFormat(locale, { weekday: 'short' }),
    monthDay: new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }),
    monthDayClock: new Intl.DateTimeFormat(locale, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }),
    clock: new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }),
    full: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }),
    compact: new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }),
    integer: new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }),
    tenths: new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }),
    percent: new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }),
    usdCents: new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }),
    usdWhole: new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 0,
    }),
  }
}

function format(): ReturnType<typeof makeFormatters> {
  const locale = currentLocale()
  let made = formatters.get(locale)
  if (!made) formatters.set(locale, (made = makeFormatters(locale)))
  return made
}

/** A compact relative time for lists: "now", "4 min", "2 h", "3 d", "1 w", "Oct 3". */
export function shortAgo(at: number, now = Date.now()): string {
  const delta = Math.max(0, now - at)
  if (delta < MINUTE) return i18n.t('time.now')
  if (delta < HOUR) return i18n.t('time.minutesShort', { count: Math.floor(delta / MINUTE) })
  if (delta < DAY) return i18n.t('time.hoursShort', { count: Math.floor(delta / HOUR) })
  if (delta < WEEK) return i18n.t('time.daysShort', { count: Math.floor(delta / DAY) })
  if (delta < 4 * WEEK) return i18n.t('time.weeksShort', { count: Math.floor(delta / WEEK) })
  return format().monthDay.format(at)
}

/**
 * The relative time of a sentence and of a status line: "just now", "12 min ago", "2 h ago",
 * "yesterday", "3 days ago", then the date.
 */
function ago(at: number, now: number): string | null {
  const delta = Math.max(0, now - at)
  if (delta < MINUTE) return i18n.t('time.justNow')
  if (delta < HOUR) return i18n.t('time.minAgo', { count: Math.floor(delta / MINUTE) })
  if (delta < DAY) return i18n.t('time.hAgo', { count: Math.floor(delta / HOUR) })
  if (delta < 2 * DAY) return i18n.t('time.yesterday')
  if (delta < WEEK) return i18n.t('time.daysAgo', { count: Math.floor(delta / DAY) })
  return null
}

/** A relative time for sentences, with "on Oct 3" past a week. */
export function longAgo(at: number, now = Date.now()): string {
  return ago(at, now) ?? i18n.t('time.onDate', { date: format().monthDay.format(at) })
}

/** A relative time for a status line, with the date alone past a week: "Oct 18". */
export function mediumAgo(at: number, now = Date.now()): string {
  return ago(at, now) ?? format().monthDay.format(at)
}

/** Calendar days from `now` to a reset at `at`, rounded since a day across a DST change is not 24 hours. */
function daysAhead(at: number, now: number): number {
  const day = (t: number): number => new Date(t).setHours(0, 0, 0, 0)
  return Math.round((day(at) - day(now)) / DAY)
}

/** When a limit resets: the clock time today, the weekday and time within six days, the date beyond. */
export function resetTime(at: number, now = Date.now()): string {
  const days = daysAhead(at, now)
  if (days === 0) return format().clock.format(at)
  return days > 0 && days <= 6 ? format().weekdayClock.format(at) : format().monthDay.format(at)
}

/** `resetTime` for a tag that has little room: the weekday alone within six days. */
export function resetDay(at: number, now = Date.now()): string {
  const days = daysAhead(at, now)
  if (days === 0) return format().clock.format(at)
  return days > 0 && days <= 6 ? format().weekday.format(at) : format().monthDay.format(at)
}

export function fullTime(at: number): string {
  return format().full.format(at)
}

/** The clock time alone: "14:32", or "2:32 PM" in English. */
export function clockTime(at: number): string {
  return format().clock.format(at)
}

/** The day alone: "Oct 28", "10月28日". */
export function monthDay(at: number): string {
  return format().monthDay.format(at)
}

/** The day and the clock time, without the year: "Dec 12, 2:05 PM", "12月12日 14:05". */
export function monthDayTime(at: number): string {
  return format().monthDayClock.format(at)
}

/** Calendar days from `at` to `now`: 0 the same day, 1 the day before. */
export function daysBefore(at: number, now = Date.now()): number {
  const day = (t: number): number => new Date(t).setHours(0, 0, 0, 0)
  // Rounded, since a day across a DST change is not 24 hours.
  return Math.round((day(now) - day(at)) / DAY)
}

/** "2 m 13 s", "48 s", "1 h 5 m", in a sentence or a status line. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return i18n.t('time.seconds', { s })
  const m = Math.floor(s / 60)
  if (m < 60) return i18n.t('time.minutesSeconds', { m, s: s % 60 })
  return i18n.t('time.hoursMinutes', { h: Math.floor(m / 60), m: m % 60 })
}

/** "2m 13s", "48s", "1h 5m", for a column of durations such as a pull request's checks. */
export function shortDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return i18n.t('time.secondsShort', { s })
  const m = Math.floor(s / 60)
  if (m < 60) return i18n.t('time.minutesSecondsShort', { m, s: s % 60 })
  return i18n.t('time.hoursMinutesShort', { h: Math.floor(m / 60), m: m % 60 })
}

/** How long a turn has run, to the minute once it passes one: "45 s", "4 m", "1 h 20 m". */
export function runningFor(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return i18n.t('time.seconds', { s })
  const m = Math.floor(s / 60)
  if (m < 60) return i18n.t('time.minutes', { m })
  return i18n.t('time.hoursMinutes', { h: Math.floor(m / 60), m: m % 60 })
}

/** A clip's length as "0:07", "4:12" or "1:02:03", in whole seconds. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const mmss = `${Math.floor(s / 60) % 60}:${String(s % 60).padStart(2, '0')}`
  if (s < 3600) return mmss
  return `${Math.floor(s / 3600)}:${mmss.padStart(5, '0')}`
}

/** Time left as "4:12", in whole seconds rounded up, so it reads 0:00 only once the time is up. */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Within this much time left, `timeLeft` counts seconds. */
export const SECONDS_LEFT = 5 * 60_000

/** Time left as "52 min", in whole minutes rounded down, then as a `countdown` in the last five. */
export function timeLeft(ms: number): string {
  return ms > SECONDS_LEFT
    ? i18n.t('time.minutesLeft', { m: Math.floor(ms / 60_000) })
    : countdown(ms)
}

type WindowTable = 'planWindow' | 'planWindowInText' | 'composer:usage.shortWindow'

/** The window's own name from one of the catalogs, without the model or group it counts. */
function windowName(parts: Pick<WindowParts, 'kind' | 'count'>, table: WindowTable): string {
  const key = `${table}.${parts.kind}` as 'planWindow.five_hour'
  return parts.count === null ? i18n.t(key) : i18n.t(key, { count: parts.count })
}

type WindowName = Pick<WindowParts, 'kind' | 'count' | 'scope'>

/** A window's long name, the length first and then the model or group it is for: "Weekly · Fable". */
export function windowLabel(parts: WindowName): string {
  const name = windowName(parts, 'planWindow')
  return parts.scope ? i18n.t('planWindow.scoped', { window: name, scope: parts.scope }) : name
}

/** A plan-limit window's name: Kettu's for the windows it knows, else the agent's own. */
export function limitLabel(limit: Pick<PlanLimit, 'window' | 'label'>): string {
  const parts = windowParts(limit)
  if (!parts.kind) return limit.label
  return parts.provider ? `${parts.provider} · ${windowLabel(parts)}` : windowLabel(parts)
}

/** A window's name without the model it is for: "Weekly" for "Weekly · Fable". */
export function limitWindowName(limit: Pick<PlanLimit, 'window' | 'label'>): string {
  const parts = windowParts(limit)
  return parts.kind && !parts.provider ? windowName(parts, 'planWindow') : limitLabel(limit)
}

/**
 * A window's name inside a sentence: "Fable weekly", since "Weekly · Fable limit reached" reads as
 * two windows.
 */
export function limitPhrase(limit: Pick<PlanLimit, 'window' | 'label'>): string {
  const parts = windowParts(limit)
  if (!parts.kind || !parts.scope) return limitLabel(limit)
  return i18n.t('planWindowInText.scoped', {
    scope: parts.scope,
    window: windowName(parts, 'planWindowInText'),
  })
}

/**
 * A window's short name where space is tight, the length first and then the model or group it is
 * for, without the "Models" a group's name ends in: "5h", "7d Fable", "5h Gemini".
 */
export function windowShort(parts: WindowName, separator = ' '): string {
  const name = windowName(parts, 'composer:usage.shortWindow')
  const scope = shortScope(parts)
  return scope ? `${name}${separator}${scope}` : name
}

const shortScope = (parts: Pick<WindowParts, 'scope'>): string | null =>
  parts.scope?.replace(/\s+models?$/i, '') ?? null

export function limitShort(limit: Pick<PlanLimit, 'window' | 'label'>, separator = ' '): string {
  const parts = windowParts(limit)
  return parts.kind ? windowShort(parts, separator) : limit.label
}

/** The end of `limitShort` that names a model, group or pool, as written there; null without one. */
export function limitShortScope(limit: Pick<PlanLimit, 'window' | 'label'>): string | null {
  const parts = windowParts(limit)
  return parts.kind ? shortScope(parts) : null
}

/** A count compactly, for figures, readouts and legends: "980", "1.2K", "41.7B". */
export function count(n: number): string {
  return format().compact.format(n)
}

/** Token counts everywhere: "980", "41K", "1.2M", "41.7B"; in Chinese, in its own wan and yi. */
export function tokens(n: number): string {
  return count(n)
}

/** US dollars, with cents under $100: "$4.20", "$1,234". */
export function usd(amount: number): string {
  return (amount < 100 ? format().usdCents : format().usdWhole).format(amount)
}

/** A rate or a time, whole from 10 up and to a tenth below: "82", "7.8". */
export function measure(n: number): string {
  return (n >= 10 ? format().integer : format().tenths).format(n)
}

/** A count in full, for tables and tooltips: "35,317,988,871". */
export function exactCount(n: number): string {
  return format().integer.format(n)
}

/** A share as a percentage with one decimal: "98.5%". */
export function percent(share: number): string {
  return format().percent.format(share)
}

/**
 * "812 B", "41 KB", "1.2 MB", with the number in the locale's format. The unit is written out,
 * since Intl's short byte unit reads "byte" and its kilobyte "kB".
 */
export function bytes(n: number): string {
  const [value, unit] =
    n < 1000 ? [n, 'B'] : n < 1_000_000 ? [n / 1000, 'KB'] : [n / 1_000_000, 'MB']
  const number = new Intl.NumberFormat(currentLocale(), {
    maximumFractionDigits: n < 1000 ? 0 : 1,
  }).format(value)
  return `${number} ${unit}`
}

/**
 * Cloud storage, as "12.3 MB" or "2 GB": in units of 1024, as storage limits are set, so a limit
 * of 2 GiB reads 2 GB rather than 2.1.
 */
export function storageBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = n
  let unit = 0
  // By the value as shown, so 2047.96 MB reads 2 GB rather than 2,048 MB.
  while (unit < units.length - 1 && Math.round(value * 10) / 10 >= 1024) {
    value /= 1024
    unit++
  }
  const number = new Intl.NumberFormat(currentLocale(), {
    maximumFractionDigits: unit === 0 ? 0 : 1,
  }).format(value)
  return `${number} ${units[unit]}`
}

export function money(amount: number, currency: string): string {
  return new Intl.NumberFormat(currentLocale(), { style: 'currency', currency }).format(amount)
}

/** A plan window's used and total amount, or a currency amount for a money-denominated window. */
export function planAmount(used: number, total: number, unit: string, unitLabel = unit): string {
  if (/^[A-Z]{3}$/.test(unit)) return `${money(used, unit)} / ${money(total, unit)}`
  const number = new Intl.NumberFormat(currentLocale(), { maximumFractionDigits: 2 })
  return `${number.format(used)} / ${number.format(total)} ${unitLabel}`
}

/** A balance expressed either as money or as a count of its own units. */
export function planBalance(amount: number, unit: string, unitLabel = unit): string {
  if (/^[A-Z]{3}$/.test(unit)) return money(amount, unit)
  return `${new Intl.NumberFormat(currentLocale(), { maximumFractionDigits: 2 }).format(amount)} ${unitLabel}`
}

// The host names a balance in English, the same for every client, and each client shows it in its
// own language. A product's own name, such as G1 credits, stays as sent.
const BALANCE_LABELS = {
  Balance: 'usage:limits.balance',
  'Prepaid balance': 'usage:limits.prepaidBalance',
  'Extra usage': 'usage:limits.extraUsage',
  'Add-on credits': 'usage:limits.addOnCredits',
  'Recharge balance': 'usage:limits.rechargeBalance',
  'Bonus balance': 'usage:limits.bonusBalance',
} as const

/** A balance's name in the interface language. */
export function balanceLabel(label: string): string {
  return Object.hasOwn(BALANCE_LABELS, label)
    ? i18n.t(BALANCE_LABELS[label as keyof typeof BALANCE_LABELS])
    : label
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

/** The local path of a `file://` URI, in the platform's form, without a trailing separator; else null. */
export function fileUrlPath(uri: string, platform: string): string | null {
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    return null
  }
  if (url.protocol !== 'file:') return null
  let path: string
  try {
    path = decodeURIComponent(url.pathname)
  } catch {
    return null
  }
  if (platform === 'win32') {
    path = url.hostname
      ? `\\\\${url.hostname}${path.replace(/\//g, '\\')}`
      : path.replace(/^\/([a-z]:)/i, '$1').replace(/\//g, '\\')
    return path.length > 3 ? path.replace(/\\+$/, '') : path
  }
  return path.length > 1 ? path.replace(/\/+$/, '') : path
}

/** A path relative to the project when it is inside it; another host's as that host writes it. */
export function relativePath(path: string, projectPath: string): string {
  const root = hostPath(projectPath).replace(/[\\/]+$/, '')
  if (path === root) return basename(path)
  if (path.startsWith(root + '/') || path.startsWith(root + '\\'))
    return path.slice(root.length + 1)
  return path
}
