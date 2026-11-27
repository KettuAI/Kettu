// Extracting a readable, redacted diagnostic summary when an agent process exits mid-turn.

import { redactLogText } from '@shared/log/process-log'
import type { ExitInfo } from './agent-process'
import { isDiskFullText } from './disk-full'
import { t } from './i18n'

/** Max stderr lines inspected from the tail of the agent's stderr stream. */
const TAIL_LINES = 60
/** Max summary lines included in a stopped-turn notice description. */
const MAX_SUMMARY_LINES = 2
/** Max characters for the extracted stderr excerpt. */
const MAX_SUMMARY_CHARS = 240

// ANSI CSI, OSC, and simple 2-byte escape sequences.
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-9;?]*[ -/]*[@-~]|[@-Z\\-_])/g

// Boilerplate noise lines that rarely explain why a process exited.
const NOISE_LINES: readonly RegExp[] = [
  /^\s*at\s+/,
  /^Node\.js v\d+/i,
  /^\s*\^+\s*$/,
  /^\(node:\d+\)\s+(?:ExperimentalWarning|DeprecationWarning|MaxListenersExceededWarning|Warning:)/i,
  /^\(Use `node --trace-/i,
  /^[-=_*#~\u2022\u00b7.\s]{3,}$/,
  /^npm\s+(?:notice|warn)\b/i,
]

// Routine info/debug log lines that should not be surfaced as a crash cause on their own.
const LOW_SIGNAL_LOGS =
  /^(?:\[?\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\]?\s*)?(?:\[?(?:DEBUG|TRACE|INFO)\]?(?:\s|:|-)|(?:debug|trace|info):)/i

// Patterns that indicate an actual failure line in stderr.
const ERROR_SIGNAL =
  /\b(?:error|err|fatal|panic|exception|unhandled|oom|out of memory|heap out of memory|segmentation fault|aborted|killed|eacces|eperm|enoent|enomem|emfile|enospc|edquot|econnrefused|econnreset|etimedout|epipe|failed|traceback)\b/i

// Generic transport-close messages produced internally by drivers; not informative as stderr detail.
const GENERIC_CLOSED_MESSAGES: readonly RegExp[] = [
  /^The agent (?:connection closed|stopped before it answered|process exited)$/i,
  /^The connection to .+ is closed$/i,
  /^.+ (?:stopped|exited mid-turn|closed its connection)$/i,
  /^closed its connection$/i,
]

export interface StderrSummaryOptions {
  maxLines?: number
  maxChars?: number
  redact?: (text: string) => string
}

export interface StderrSummary {
  summary: string
  diskFull: boolean
}

export interface AgentExitDetail {
  info?: ExitInfo | null
  stderr?: string
  /** Underlying error message when a turn request rejects before the exit event settles. */
  errorMessage?: string
  /** Whether the host is currently seeing disk-full failures writing state files. */
  diskFull?: boolean
}

/** Removes terminal escape sequences and control characters (keeping newlines and tabs). */
export function stripAnsi(text: string): string {
  return (
    text
      .replace(ANSI_ESCAPE, '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
  )
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`
}

function isNoiseLine(line: string): boolean {
  return NOISE_LINES.some((pattern) => pattern.test(line))
}

function isGenericClosedMessage(message: string): boolean {
  const trimmed = message.trim()
  return trimmed === '' || GENERIC_CLOSED_MESSAGES.some((pattern) => pattern.test(trimmed))
}

function normalizeStderrLines(stderr: string): string[] {
  const cleaned = stripAnsi(stderr)
  const raw = cleaned.split('\n')
  const lines: string[] = []
  for (const line of raw) {
    // Handle CRLF and progress-bar carriage returns by keeping the last segment on the line.
    const parts = line.replace(/\r$/, '').split('\r')
    const final = (parts[parts.length - 1] ?? '').trim()
    if (final !== '') lines.push(final)
  }
  return lines.slice(-TAIL_LINES)
}

function pickUniqueTail(lines: readonly string[], maxLines: number): string[] {
  const picked: string[] = []
  for (let i = lines.length - 1; i >= 0 && picked.length < maxLines; i--) {
    const line = lines[i]!
    if (!picked.includes(line)) picked.unshift(line)
  }
  return picked
}

/**
 * Extracts a concise, redacted summary from the tail of an agent's stderr, prioritizing disk-full
 * and explicit error lines while filtering stack frames, deprecation notices, and debug noise.
 */
export function extractStderrSummary(
  stderr: string,
  options: StderrSummaryOptions = {},
): StderrSummary | null {
  const lines = normalizeStderrLines(stderr)
  if (lines.length === 0) return null

  const maxLines = options.maxLines ?? MAX_SUMMARY_LINES
  const maxChars = options.maxChars ?? MAX_SUMMARY_CHARS
  const redact = options.redact ?? redactLogText

  const useful = lines.filter((line) => !isNoiseLine(line))
  const diskFullLines = useful.filter((line) => isDiskFullText(line))
  const diskFull = diskFullLines.length > 0 || lines.some((line) => isDiskFullText(line))

  let chosen: string[]
  if (diskFullLines.length > 0) {
    chosen = pickUniqueTail(diskFullLines, maxLines)
  } else {
    const errorLines = useful.filter(
      (line) => ERROR_SIGNAL.test(line) && !LOW_SIGNAL_LOGS.test(line),
    )
    if (errorLines.length > 0) {
      chosen = pickUniqueTail(errorLines, maxLines)
    } else {
      const meaningful = useful.filter((line) => !LOW_SIGNAL_LOGS.test(line))
      chosen = pickUniqueTail(meaningful, maxLines)
    }
  }

  if (chosen.length === 0) return diskFull ? { summary: '', diskFull: true } : null
  const joined = chosen.map((line) => redact(line).trim()).filter((line) => line !== '')
  if (joined.length === 0) return diskFull ? { summary: '', diskFull: true } : null
  return {
    summary: truncateText(joined.join('\n'), maxChars),
    diskFull,
  }
}

/**
 * Formats a human-readable diagnostic description for a turn interrupted by an unexpected agent exit.
 * Returns `undefined` when no exit status, stderr detail, or disk-full signal is available.
 */
export function formatExitReason(
  detail: AgentExitDetail,
  options: StderrSummaryOptions = {},
): string | undefined {
  const redact = options.redact ?? redactLogText
  const maxChars = options.maxChars ?? MAX_SUMMARY_CHARS
  const stderrInfo = detail.stderr ? extractStderrSummary(detail.stderr, options) : null

  const rawError =
    detail.errorMessage && !isGenericClosedMessage(detail.errorMessage)
      ? truncateText(redact(stripAnsi(detail.errorMessage).trim()), maxChars)
      : ''
  const infoError =
    detail.info?.error && !detail.info.closed && !isGenericClosedMessage(detail.info.error)
      ? truncateText(redact(stripAnsi(detail.info.error).trim()), maxChars)
      : ''

  const detailText = stderrInfo?.summary || infoError || rawError
  const diskFull = Boolean(
    detail.diskFull ||
    stderrInfo?.diskFull ||
    (detail.errorMessage && isDiskFullText(detail.errorMessage)) ||
    (detail.info?.error && isDiskFullText(detail.info.error)),
  )

  const info = detail.info ?? null
  let exitLine = ''
  if (info?.signal) {
    exitLine = detailText
      ? t('notice.stopped.signalWithDetail', { signal: info.signal, detail: detailText })
      : t('notice.stopped.signal', { signal: info.signal })
  } else if (info && info.code !== null) {
    exitLine = detailText
      ? t('notice.stopped.codeWithDetail', { code: String(info.code), detail: detailText })
      : t('notice.stopped.code', { code: String(info.code) })
  } else if (info?.closed) {
    exitLine = detailText
      ? t('notice.stopped.closedWithDetail', { detail: detailText })
      : t('notice.stopped.closed')
  } else if (detailText) {
    exitLine = detailText
  }

  if (diskFull) {
    return exitLine
      ? t('notice.stopped.diskFullWithDetail', { detail: exitLine })
      : t('notice.stopped.diskFull')
  }
  return exitLine || undefined
}
