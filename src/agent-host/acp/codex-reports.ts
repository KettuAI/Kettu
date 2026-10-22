// Codex's plan limits, which codex-acp 2.2.2 reads from Codex's `account/rateLimits/read` only
// for its `/status` command and sends as the markdown of an agent message. The format is the
// adapter's (`buildStatusMessage`), not ACP's, so text that does not match gives null and the
// caller keeps what it had.

import type { PlanLimit } from '@shared/agent-host'
import { WINDOW_LABELS } from './mapper'

const MINUTE_MS = 60_000
const DAY_MS = 86_400_000

// Codex's own pool, which codex-acp names after its limit id when the server gives no name.
const DEFAULT_POOL = 'codex'

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
}

/** The window of `formatWindowLabel`: `5h limit`, `2d limit`, `45m limit`, `Weekly limit`. */
function windowOf(text: string, resetsAt: number | null, now: number) {
  if (text === 'Weekly limit') {
    // codex-acp labels every window of a week or longer "Weekly limit", Free's 30-day one among
    // them, so the reset tells them apart, in the tiers Codex's own status line uses.
    const left = resetsAt === null ? 0 : resetsAt - now
    if (left > 31 * DAY_MS) return { window: 'annual', label: 'Annual' }
    if (left > 7 * DAY_MS + 60 * MINUTE_MS) return { window: 'monthly', label: 'Monthly' }
    return { window: 'seven_day', label: WINDOW_LABELS.seven_day! }
  }
  const match = /^(\d+)([mhd]) limit$/.exec(text)
  if (!match) return null
  const n = Number(match[1])
  if (match[2] === 'h' && n === 5) return { window: 'five_hour', label: WINDOW_LABELS.five_hour! }
  const unit = { m: 'minute', h: 'hour', d: 'day' }[match[2] as 'm' | 'h' | 'd']
  return { window: `${n}_${unit}`, label: `${n}-${unit}` }
}

/**
 * The plan limits in a `/status` report. A report from before Codex has any limits gives an
 * empty list; any other text gives null. Credits and spend limits are not windows and are left
 * out.
 */
export function parseStatusReport(markdown: string, now: number): PlanLimit[] | null {
  const lines = markdown
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
  if (!lines.some((line) => line.startsWith('**Account:**'))) return null
  const limits: PlanLimit[] = []
  for (const line of lines) {
    const match = /^\*\*(.+?):\*\* (\d+)% left(?: \(resets (.+)\))?$/.exec(line)
    const name = match && /^(?:(.*) )?(Weekly limit|\d+[mhd] limit)$/.exec(match[1]!)
    if (!match || !name) continue
    const resetsAt = match[3] ? parseStatusReset(match[3], now) : null
    const window = windowOf(name[2]!, resetsAt, now)
    if (!window) continue
    const pool = name[1] && name[1].toLowerCase() !== DEFAULT_POOL ? name[1] : null
    const used = 100 - Math.min(100, Math.max(0, Number(match[2])))
    limits.push({
      window: pool ? `${slug(pool)}_${window.window}` : window.window,
      label: pool ? `${window.label} · ${pool}` : window.label,
      usedPercent: used,
      resetsAt,
      state: used >= 100 ? 'reached' : 'ok',
      observedAt: now,
    })
  }
  return limits
}

/**
 * A reset as `formatResetTime` writes it: `14:30` for today, `09:12 on 27 Oct` for a later day,
 * in the locale and zone of the adapter, which runs on this machine. The 24-hour time and the
 * day of the month are read in any locale, and the month where it is a number or an English
 * abbreviation; without the month the reset is the next such day within a month.
 */
export function parseStatusReset(text: string, now: number): number | null {
  const match = /^(\d{1,2})[:.](\d{2})(?: on (.+))?$/.exec(text.trim())
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  const today = new Date(now)
  if (!match[3]) {
    return new Date(today.getFullYear(), today.getMonth(), today.getDate(), hour, minute).getTime()
  }
  const day = dayOfMonth(match[3])
  if (day === null) return null
  // Printed to the minute, and read a moment after the adapter wrote it.
  const future = (date: Date): boolean => date.getTime() > now - MINUTE_MS
  const month = monthOf(match[3])
  if (month !== null) {
    for (const year of [today.getFullYear(), today.getFullYear() + 1]) {
      const candidate: Date = new Date(year, month, day, hour, minute)
      if (candidate.getMonth() !== month) return null
      if (future(candidate)) return candidate.getTime()
    }
    return null
  }
  for (let offset = 0; offset <= 31; offset++) {
    const candidate = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate() + offset,
      hour,
      minute,
    )
    if (candidate.getDate() === day && future(candidate)) return candidate.getTime()
  }
  return null
}

/** `27 Oct`, `Oct 27`, `27. Okt.`: the one number; `10月27日`, `10월 27일`: the one before 日 or 일. */
function dayOfMonth(date: string): number | null {
  const marked = /(\d{1,2})\s*[日일]/.exec(date)
  const numbers = date.match(/\d+/g) ?? []
  const text = marked ? marked[1] : numbers.length === 1 ? numbers[0] : null
  const day = text ? Number(text) : NaN
  return day >= 1 && day <= 31 ? day : null
}

/** The month of `10月27日` and `10월 27일`, or of an English abbreviation; null for others. */
function monthOf(date: string): number | null {
  const numbered = /(\d{1,2})\s*[月월]/.exec(date)
  if (numbered) {
    const month = Number(numbered[1])
    return month >= 1 && month <= 12 ? month - 1 : null
  }
  const named = /\b([a-z]{3})/i.exec(date)
  const index = named ? MONTHS.indexOf(named[1]!.toLowerCase()) : -1
  return index === -1 ? null : index
}
