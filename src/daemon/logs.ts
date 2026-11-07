// `kettu logs`: the records of the daemon's log folder, filtered and in time order, and with
// `--follow` the ones written after. The detailed records stay out; a problem report carries them.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { VERBOSE_PREFIX, type LogLevel } from '@shared/log/process-log'

export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error']

export interface LogFilter {
  process: string | null
  /** This level and above. */
  level: LogLevel | null
  op: string | null
  since: number | null
  until: number | null
}

interface LogRecord {
  time: string
  at: number
  level: LogLevel
  process: string
  source: string
  message: string
  op?: string
  data?: unknown
}

const ROTATED = /^(.+?)(?:\.(\d+))?\.log$/
const AGO = /^(\d+)(s|m|h|d)$/
const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const
const FOLLOW_MS = 1000

/** A time on the command line: a span ago, such as 30m, 2h or 1d, or a date and time. */
export function parseTime(value: string, now: number): number | null {
  const ago = AGO.exec(value.trim())
  if (ago) return now - Number(ago[1]) * UNIT_MS[ago[2] as keyof typeof UNIT_MS]
  const at = Date.parse(value)
  return Number.isFinite(at) ? at : null
}

function parseRecord(line: string): LogRecord | null {
  if (!line.startsWith('{')) return null
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const at = typeof record.time === 'string' ? Date.parse(record.time) : NaN
  if (!Number.isFinite(at) || !LOG_LEVELS.includes(record.level as LogLevel)) return null
  if (typeof record.message !== 'string') return null
  return {
    time: record.time as string,
    at,
    level: record.level as LogLevel,
    process: typeof record.process === 'string' ? record.process : '',
    source: typeof record.source === 'string' ? record.source : '',
    message: record.message,
    ...(typeof record.op === 'string' ? { op: record.op } : {}),
    ...(record.data !== undefined ? { data: record.data } : {}),
  }
}

function matches(record: LogRecord, filter: LogFilter): boolean {
  if (filter.process !== null && record.process !== filter.process) return false
  if (filter.level !== null) {
    if (LOG_LEVELS.indexOf(record.level) < LOG_LEVELS.indexOf(filter.level)) return false
  }
  if (filter.op !== null && record.op !== filter.op) return false
  if (filter.since !== null && record.at < filter.since) return false
  if (filter.until !== null && record.at > filter.until) return false
  return true
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0')
}

/** One record on one line, in local time. */
export function formatRecord(record: LogRecord): string {
  const date = new Date(record.at)
  const time =
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.` +
    pad(date.getMilliseconds(), 3)
  const op = record.op ? ` [${record.op}]` : ''
  const data = record.data === undefined ? '' : ` ${JSON.stringify(record.data)}`
  return `${time} ${record.level.toUpperCase().padEnd(5)} ${record.process} ${record.source}: ${record.message}${op}${data}\n`
}

interface LogFile {
  name: string
  index: number
  file: string
}

/** The process logs, each name's rotations oldest first. */
async function logFiles(dir: string): Promise<LogFile[]> {
  const names = await fs.readdir(dir).catch(() => [] as string[])
  const files: LogFile[] = []
  for (const name of names) {
    if (name.startsWith(VERBOSE_PREFIX)) continue
    const match = ROTATED.exec(name)
    if (!match) continue
    files.push({ name: match[1]!, index: Number(match[2] ?? 0), file: path.join(dir, name) })
  }
  return files.sort((a, b) => a.name.localeCompare(b.name) || b.index - a.index)
}

function recordsOf(text: string, filter: LogFilter): LogRecord[] {
  const kept: LogRecord[] = []
  for (const line of text.split('\n')) {
    const record = parseRecord(line)
    if (record && matches(record, filter)) kept.push(record)
  }
  return kept
}

/** Every record of the folder the filter keeps, oldest first. */
export async function readLogs(dir: string, filter: LogFilter): Promise<string[]> {
  const records: LogRecord[] = []
  for (const entry of await logFiles(dir)) {
    const text = await fs.readFile(entry.file, 'utf8').catch(() => '')
    records.push(...recordsOf(text, filter))
  }
  // Stable, so records of the same millisecond keep the order they were written in.
  return records.sort((a, b) => a.at - b.at).map(formatRecord)
}

/** Shows the records written to the current files from now on, until `signal` aborts. */
export async function followLogs(
  dir: string,
  filter: LogFilter,
  write: (text: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const read = new Map<string, number>()
  const partial = new Map<string, string>()
  const current = async (): Promise<string[]> =>
    (await logFiles(dir)).filter((entry) => entry.index === 0).map((entry) => entry.file)
  for (const file of await current()) {
    read.set(file, (await fs.stat(file).catch(() => null))?.size ?? 0)
  }
  while (!signal.aborted) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, FOLLOW_MS)
      signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true })
    })
    if (signal.aborted) return
    for (const file of await current()) {
      const size = (await fs.stat(file).catch(() => null))?.size
      if (size === undefined) continue
      // A file smaller than what was read is a new one, after the old was rotated away.
      let from = read.get(file) ?? 0
      if (size < from) {
        from = 0
        partial.delete(file)
      }
      if (size === from) continue
      const handle = await fs.open(file, 'r').catch(() => null)
      if (!handle) continue
      try {
        const buffer = Buffer.alloc(size - from)
        await handle.read(buffer, 0, buffer.length, from)
        read.set(file, size)
        const text = (partial.get(file) ?? '') + buffer.toString('utf8')
        const end = text.lastIndexOf('\n')
        partial.set(file, text.slice(end + 1))
        for (const record of recordsOf(text.slice(0, end + 1), filter)) {
          write(formatRecord(record))
        }
      } finally {
        await handle.close()
      }
    }
  }
}
