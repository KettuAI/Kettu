const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' })
const monthDay = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const full = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/** A compact relative time for lists: "now", "4m", "2h", "Mon", "Oct 3". */
export function shortAgo(at: number, now = Date.now()): string {
  const delta = Math.max(0, now - at)
  if (delta < MINUTE) return 'now'
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m`
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h`
  if (delta < 7 * DAY) return weekday.format(at)
  return monthDay.format(at)
}

/** A relative time for sentences: "just now", "5 minutes ago", "2 hours ago", "on Oct 3". */
export function longAgo(at: number, now = Date.now()): string {
  const delta = Math.max(0, now - at)
  if (delta < MINUTE) return 'just now'
  if (delta < HOUR) return plural(Math.floor(delta / MINUTE), 'minute') + ' ago'
  if (delta < DAY) return plural(Math.floor(delta / HOUR), 'hour') + ' ago'
  if (delta < 2 * DAY) return 'yesterday'
  return `on ${monthDay.format(at)}`
}

/** When a limit resets: the clock time today, the weekday later. */
export function resetTime(at: number, now = Date.now()): string {
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString()
  return sameDay ? clock.format(at) : weekday.format(at)
}

export function fullTime(at: number): string {
  return full.format(at)
}

/** "2 m 13 s", "48 s", "1 h 5 m". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} m ${s % 60} s`
  return `${Math.floor(m / 60)} h ${m % 60} m`
}

/** "980", "41k", "1.2M". */
export function tokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n} ${n === 1 ? word : pluralWord}`
}

export function money(amount: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount)
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
