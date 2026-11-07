// A problem report: what the user asks for, and the bundle a host builds from it. Shared by the
// window, main, the hosts and the daemon, so it holds types and checks only.

export const REPORT_RANGES = ['hour', 'today', 'twoDays'] as const
export type ReportRangeName = (typeof REPORT_RANGES)[number]

/** A named range ending now, or the span a recording of steps to reproduce covered. */
export type ReportRange = { kind: ReportRangeName } | { kind: 'span'; from: number; to: number }

/** What the user may add, each off unless chosen. */
export const REPORT_EXTRAS = ['titles', 'messages', 'verbose', 'dumps', 'screenshot'] as const
export type ReportExtra = (typeof REPORT_EXTRAS)[number]

/** Where the dialog was opened from an error: the session or agent it was about, and the error. */
export interface ReportContext {
  sessionId: string | null
  agentId: string | null
  error: string | null
}

export interface ReportRequest {
  description: string
  range: ReportRange
  extras: ReportExtra[]
  context: ReportContext | null
}

export type ReportFileKind = 'text' | 'image' | 'binary'

export interface ReportFileInfo {
  path: string
  size: number
  kind: ReportFileKind
}

/** A bundle built and kept until it is saved or dropped. */
export interface PreparedReport {
  id: string
  files: ReportFileInfo[]
  /** The zip's size in bytes. */
  size: number
}

/** A host's answer to a request for a bundle: where it wrote the zip, and what is in it. */
export type ReportBuildResult =
  | { ok: true; file: string; files: ReportFileInfo[]; size: number }
  | { ok: false; reason: 'too_large' | 'failed'; message: string }

/** A file of a prepared bundle, as the dialog shows it. */
export type ReportFileView =
  | { kind: 'text'; text: string; truncated: boolean }
  | { kind: 'image'; dataUrl: string }
  | { kind: 'binary' }

export const REPORT_DESCRIPTION_MAX = 10_000
/** The most a bundle may hold, which is also what the service takes. */
export const REPORT_MAX_BYTES = 50 * 1024 * 1024
/** The longest a recording of steps to reproduce runs before it stops by itself. */
export const RECORDING_MAX_MS = 30 * 60 * 1000
/** A bundle another host sends travels as base64 in one message of its channel. */
export const REMOTE_REPORT_MAX_BYTES = 20 * 1024 * 1024

const HOUR_MS = 60 * 60 * 1000
const MAX_SPAN_MS = 2 * 24 * HOUR_MS
const ID_MAX = 200
/** The error an error screen hands the report, which keeps its start. */
export const REPORT_ERROR_MAX = 4_000

/** The times a range covers, in Unix milliseconds; `today` starts at local midnight. */
export function rangeBounds(range: ReportRange, now: number): { from: number; to: number } {
  switch (range.kind) {
    case 'hour':
      return { from: now - HOUR_MS, to: now }
    case 'today': {
      const midnight = new Date(now)
      midnight.setHours(0, 0, 0, 0)
      return { from: midnight.getTime(), to: now }
    }
    case 'twoDays':
      return { from: now - 2 * 24 * HOUR_MS, to: now }
    case 'span':
      return { from: range.from, to: range.to }
  }
}

export class ReportRequestError extends Error {}

function fail(message: string): never {
  throw new ReportRequestError(message)
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    fail(`${what} is not an object`)
  return value as Record<string, unknown>
}

function optionalText(value: unknown, max: number, what: string): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || value.length > max) fail(`${what} is not text of at most ${max}`)
  return value
}

function parseRange(value: unknown): ReportRange {
  const range = record(value, 'The range')
  if ((REPORT_RANGES as readonly unknown[]).includes(range.kind)) {
    return { kind: range.kind as ReportRangeName }
  }
  if (range.kind !== 'span') fail('The range is not one the dialog offers')
  const { from, to } = range
  if (
    typeof from !== 'number' ||
    typeof to !== 'number' ||
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    from > to ||
    to - from > MAX_SPAN_MS
  ) {
    fail('The span is not a range of times')
  }
  return { kind: 'span', from, to }
}

/** A request as it came over IPC, a device's channel or the daemon's socket, checked. */
export function parseReportRequest(value: unknown): ReportRequest {
  const request = record(value, 'The request')
  const description = request.description
  if (typeof description !== 'string' || description.trim() === '') {
    fail('Describe what happened')
  }
  if (description.length > REPORT_DESCRIPTION_MAX) {
    fail(`The description is longer than ${REPORT_DESCRIPTION_MAX} characters`)
  }
  if (!Array.isArray(request.extras)) fail('The extras are not a list')
  const extras = [...new Set(request.extras as unknown[])]
  for (const extra of extras) {
    if (!(REPORT_EXTRAS as readonly unknown[]).includes(extra)) fail('An extra is not one offered')
  }
  let context: ReportContext | null = null
  if (request.context !== null && request.context !== undefined) {
    const raw = record(request.context, 'The context')
    context = {
      sessionId: optionalText(raw.sessionId, ID_MAX, 'The session id'),
      agentId: optionalText(raw.agentId, ID_MAX, 'The agent id'),
      error: optionalText(raw.error, REPORT_ERROR_MAX, 'The error'),
    }
  }
  return {
    description: description.trim(),
    range: parseRange(request.range),
    extras: extras as ReportExtra[],
    context,
  }
}

/** A bundle's file name in the zip: relative, forward slashes, no parent steps. */
export function isReportPath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    path.length <= 300 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !path.split('/').some((part) => part === '' || part === '.' || part === '..')
  )
}

export function reportFileKind(path: string): ReportFileKind {
  if (/\.(?:json|log|txt|md)$/i.test(path)) return 'text'
  if (/\.png$/i.test(path)) return 'image'
  return 'binary'
}

function isFileInfo(value: unknown): value is ReportFileInfo {
  if (typeof value !== 'object' || value === null) return false
  const { path, size, kind } = value as Record<string, unknown>
  return (
    isReportPath(path) &&
    typeof size === 'number' &&
    Number.isSafeInteger(size) &&
    size >= 0 &&
    (kind === 'text' || kind === 'image' || kind === 'binary')
  )
}

/** A host's answer as it came over a process boundary, or a failure in its place. */
export function reportBuildResult(value: unknown): ReportBuildResult {
  const failed: ReportBuildResult = {
    ok: false,
    reason: 'failed',
    message: 'The host gave no bundle',
  }
  if (typeof value !== 'object' || value === null) return failed
  const answer = value as Record<string, unknown>
  if (answer.ok === false) {
    return {
      ok: false,
      reason: answer.reason === 'too_large' ? 'too_large' : 'failed',
      message: typeof answer.message === 'string' ? answer.message.slice(0, 2_000) : '',
    }
  }
  if (
    answer.ok !== true ||
    typeof answer.file !== 'string' ||
    !Array.isArray(answer.files) ||
    !answer.files.every(isFileInfo) ||
    typeof answer.size !== 'number'
  ) {
    return failed
  }
  return { ok: true, file: answer.file, files: answer.files, size: answer.size }
}

/** The id the service gives a submitted report, to put in an issue. */
export const REPORT_ID = /^KR-[0-9A-HJKMNP-TV-Z]{6}$/

export const REPORT_SUBMIT_FAILURES = [
  'too_large',
  'rate_limited',
  'unauthorized',
  'signed_out',
  'network',
  'failed',
] as const
export type ReportSubmitFailure = (typeof REPORT_SUBMIT_FAILURES)[number]

/** A submitted report's id, with the version and system of the host that sent it, or why not. */
export type ReportSubmitResult =
  | { ok: true; id: string; version: string; system: string }
  | { ok: false; reason: ReportSubmitFailure }

/** An answer as it came over a process boundary or a device's channel, or a failure in its place. */
export function reportSubmitResult(value: unknown): ReportSubmitResult {
  if (typeof value !== 'object' || value === null) return { ok: false, reason: 'failed' }
  const answer = value as Record<string, unknown>
  if (answer.ok === false) {
    const reason = REPORT_SUBMIT_FAILURES.find((known) => known === answer.reason)
    return { ok: false, reason: reason ?? 'failed' }
  }
  const text = (field: unknown): field is string =>
    typeof field === 'string' && field.length > 0 && field.length <= 200
  if (
    answer.ok !== true ||
    typeof answer.id !== 'string' ||
    !REPORT_ID.test(answer.id) ||
    !text(answer.version) ||
    !text(answer.system)
  ) {
    return { ok: false, reason: 'failed' }
  }
  return { ok: true, id: answer.id, version: answer.version, system: answer.system }
}

/** The code repository's bug report form, with the version, system and report id filled in. */
export function reportIssueUrl(report: { id: string; version: string; system: string }): string {
  const query = new URLSearchParams({
    template: 'bug.yml',
    version: report.version,
    os: report.system,
    logs: `Problem report ${report.id}`,
  })
  return `https://github.com/KettuAI/Kettu/issues/new?${query}`
}
