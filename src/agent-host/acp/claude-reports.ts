// Claude Code's `/usage` and `/context` reports, which claude-agent-acp 0.94 sends as the
// markdown of an agent message and exposes nowhere else: the current use of every plan limit,
// and what fills a session's context. Both formats are the adapter's and Claude Code's, not
// ACP's, so a report that does not match gives null and the caller keeps what it had.

import type { ContextBreakdown, ContextList, PlanLimit } from '@shared/agent-host'
import { WINDOW_LABELS } from './mapper'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAY_MS = 86_400_000

/** The adapter escapes these with a backslash (`escapeMarkdown` in usage-markdown.js). */
function unescape(text: string): string {
  return text.replace(/\\([\\`*_[\]<>|])/g, '$1')
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
}

/** The window id the rate-limit events use for the same limit, so the two merge. */
function usageWindow(label: string): string {
  if (label === '5-hour limit') return 'five_hour'
  if (label === 'Weekly · all models') return 'seven_day'
  const weekly = /^Weekly · (.+)$/.exec(label)
  return weekly ? `seven_day_${slug(weekly[1]!)}` : slug(label)
}

/**
 * A reset as the adapter formats it, `Oct 21, 3:00 PM PDT`: English, no year, in the zone of
 * the machine both processes run on. A `GMT+8` or `UTC` zone is applied as written; a named one
 * such as `PDT` is taken to be the local zone it came from. The year is now's, or the next one
 * for a reset that would otherwise lie more than a day in the past.
 */
export function parseResetTime(text: string, now: number): number | null {
  const match = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{1,2}):(\d{2})\s?([AP]M)(?:\s+(\S+))?$/.exec(
    text.trim(),
  )
  if (!match) return null
  const month = MONTHS.indexOf(match[1]!)
  if (month < 0) return null
  const day = Number(match[2])
  const hour = (Number(match[3]) % 12) + (match[5] === 'PM' ? 12 : 0)
  const minute = Number(match[4])
  const offset = zoneOffset(match[6])
  const at = (year: number): number =>
    offset === null
      ? new Date(year, month, day, hour, minute).getTime()
      : Date.UTC(year, month, day, hour, minute) - offset
  const year = new Date(now).getFullYear()
  const time = at(year)
  return time < now - DAY_MS ? at(year + 1) : time
}

/** Minutes east of UTC, in milliseconds, for `GMT`, `UTC` and `GMT+5:30`; null for a name. */
function zoneOffset(zone: string | undefined): number | null {
  if (!zone) return null
  const match = /^(?:GMT|UTC)(?:([+-])(\d{1,2})(?::(\d{2}))?)?$/.exec(zone)
  if (!match) return null
  if (!match[1]) return 0
  const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0)
  return (match[1] === '-' ? -minutes : minutes) * 60_000
}

/**
 * The plan limits in a `/usage` report (`formatUsageResponse` in the adapter's
 * usage-markdown.js). An account without limits gives an empty list; text that is not the
 * structured report, such as Claude Code's own output when the adapter falls back to it,
 * gives null.
 */
export function parseUsageReport(markdown: string, now: number): PlanLimit[] | null {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  if (lines[0]?.trim() !== '## Usage') return null
  const start = lines.findIndex((line) => line.trim() === '### Limits')
  if (start < 0) return []
  const limits: PlanLimit[] = []
  for (const line of lines.slice(start + 1)) {
    const text = line.trim()
    if (text === '---' || text.startsWith('#')) break
    const match = /^\*\*(.+?)\*\* — \*\*(\d+(?:\.\d+)?)%\*\*(?: · Resets (.+))?$/.exec(text)
    if (!match) continue
    const label = unescape(match[1]!)
    const window = usageWindow(label)
    const used = Math.min(100, Math.max(0, Number(match[2])))
    limits.push({
      window,
      label: WINDOW_LABELS[window] ?? label,
      usedPercent: used,
      resetsAt: match[3] ? parseResetTime(unescape(match[3]), now) : null,
      state: used >= 100 ? 'reached' : 'ok',
      observedAt: now,
    })
  }
  return limits
}

/** `32.1k`, `600k`, `1.2M` or `671`, as the report rounds them; null for anything else. */
function parseTokens(text: string): number | null {
  const match = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(text.trim())
  if (!match) return null
  const scale = { '': 1, k: 1e3, K: 1e3, m: 1e6, M: 1e6 }[match[2]!]!
  return Math.round(Number(match[1]) * scale)
}

function tableCells(line: string): string[] | null {
  const text = line.trim()
  if (!text.startsWith('|') || !text.endsWith('|')) return null
  return text
    .slice(1, -1)
    .split('|')
    .map((cell) => cell.trim())
}

/** The rows of the table that starts at or after `from`, without its header and rule. */
function tableRows(lines: string[], from: number): string[][] {
  let i = from
  while (i < lines.length && !tableCells(lines[i]!)) {
    if (lines[i]!.trim().startsWith('#')) return []
    i++
  }
  const rows: string[][] = []
  // The header and the rule under it.
  for (i += 2; i < lines.length; i++) {
    const cells = tableCells(lines[i]!)
    if (!cells) break
    rows.push(cells)
  }
  return rows
}

/** The breakdown in a `/context` report, Claude Code's own; null for any other text. */
export function parseContextReport(markdown: string, now: number): ContextBreakdown | null {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  if (lines[0]?.trim() !== '## Context Usage') return null
  let model: string | null = null
  let used: number | null = null
  let size: number | null = null
  for (const line of lines) {
    const modelMatch = /^\*\*Model:\*\*\s*(.+?)\s*$/.exec(line)
    if (modelMatch) model = modelMatch[1]!
    const tokensMatch = /^\*\*Tokens:\*\*\s*(\S+) \/ (\S+)/.exec(line)
    if (tokensMatch) {
      used = parseTokens(tokensMatch[1]!)
      size = parseTokens(tokensMatch[2]!)
    }
  }
  const start = lines.findIndex((line) => line.trim() === '### Estimated usage by category')
  if (used === null || size === null || size <= 0 || start < 0) return null
  const categories: ContextBreakdown['categories'] = []
  for (const [name, tokensText, shareText] of tableRows(lines, start + 1)) {
    const tokens = parseTokens(tokensText ?? '')
    if (!name || tokens === null) return null
    const share = /^(\d+(?:\.\d+)?)%$/.exec(shareText ?? '')
    categories.push({ name, tokens, share: share ? Number(share[1]) / 100 : null })
  }
  if (categories.length === 0) return null
  const lists: ContextList[] = []
  lines.forEach((line, index) => {
    const heading = /^### (.+)$/.exec(line.trim())
    if (!heading || index === start) return
    const items = tableRows(lines, index + 1).flatMap((cells) => {
      if (cells.length < 2 || !cells[0]) return []
      const detail = cells.slice(1, -1).filter(Boolean).join(' · ')
      return [{ name: cells[0], detail: detail || null, tokens: cells[cells.length - 1]! }]
    })
    if (items.length > 0) lists.push({ name: heading[1]!, items })
  })
  return { model, used, size, categories, lists, observedAt: now }
}
