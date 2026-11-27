// Shared parsing helpers for Pi JSONL session logs, used by both the global usage log reader and
// the per-session model requests reader so both surfaces agree on tokens, costs, models and times.

import path from 'node:path'

type Rec = Record<string, unknown>

export interface PiParsedUsage {
  /** Non-cached input tokens; null when absent or invalid in the log. */
  input: number | null
  /** Output tokens (includes reasoning in Pi); null when absent or invalid. */
  output: number | null
  /** Prompt cache read tokens; null when absent or invalid. */
  cacheRead: number | null
  /** Prompt cache write tokens; null when absent or invalid. */
  cacheWrite: number | null
  /** Reasoning tokens (counted in output); null when absent or invalid. */
  reasoning: number | null
  /** Confirmed USD cost from the log; null when missing or unpriced. */
  cost: number | null
  /** True when at least one of input, output, cacheRead or cacheWrite is greater than 0. */
  hasTokens: boolean
}

export interface PiEntryTimes {
  sentAt: number | null
  endedAt: number | null
  /** Canonical request timestamp for usage aggregation (completion time, else start time). */
  at: number | null
}

function asObject(value: unknown): Rec | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : null
}

/** Non-negative safe integer from a log field; null when missing or invalid. */
export function nonNegInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

/** Non-negative finite number from a log field; null when missing or invalid. */
export function nonNegNum(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed !== '' ? trimmed : null
}

/**
 * Confirmed USD cost from a Pi usage object. Pi writes `cost.total = 0` with
 * `totalFromProvider: false` (or without it) when it has no price for a model, so zero counts
 * only when the provider explicitly confirmed it (`totalFromProvider === true`).
 */
export function confirmedPiCost(rawUsage: unknown): number | null {
  const usage = asObject(rawUsage)
  const cost = asObject(usage?.cost)
  if (!cost) return null
  const total = nonNegNum(cost.total)
  if (total === null) return null
  if (total > 0) return total
  return cost.totalFromProvider === true ? 0 : null
}

/**
 * Parses a Pi `usage` object using only confirmed fields present in the log. Missing or malformed
 * fields stay null rather than being fabricated from `totalTokens`.
 */
export function parsePiUsage(raw: unknown): PiParsedUsage | null {
  const usage = asObject(raw)
  if (!usage) return null
  const input = nonNegInt(usage.input)
  const output = nonNegInt(usage.output)
  const cacheRead = nonNegInt(usage.cacheRead)
  const cacheWrite = nonNegInt(usage.cacheWrite)
  const reasoning = nonNegInt(usage.reasoning)
  const cost = confirmedPiCost(usage)
  if (
    input === null &&
    output === null &&
    cacheRead === null &&
    cacheWrite === null &&
    reasoning === null &&
    cost === null
  ) {
    return null
  }
  const hasTokens = (input ?? 0) + (output ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0) > 0
  return { input, output, cacheRead, cacheWrite, reasoning, cost, hasTokens }
}

/** Extracts a model name from a Pi record, treating empty or placeholder `unknown` as null. */
export function piModelName(raw: unknown): string | null {
  const value = nonEmpty(raw)
  if (!value) return null
  const lower = value.toLowerCase()
  if (lower === 'unknown' || lower === 'unknown/unknown') return null
  return value
}

/** Extracts a provider name from a Pi record, treating empty or `unknown` as null. */
export function piProviderName(raw: unknown): string | null {
  const value = nonEmpty(raw)
  if (!value) return null
  return value.toLowerCase() === 'unknown' ? null : value
}

/** Parses an ISO 8601 timestamp string to epoch ms, or null when missing or invalid. */
export function parseIsoMs(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/** Parses an epoch ms number, or null when missing or not a positive finite timestamp. */
export function parseEpochMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : null
}

/**
 * Resolves start, end and canonical timestamps for a Pi assistant entry. Pi writes request start
 * in `message.timestamp` (epoch ms), completion in `entry.timestamp` (ISO 8601) and elapsed time
 * in `message.durationMs`.
 */
export function parsePiTimes(
  entryTimestamp: unknown,
  messageTimestamp: unknown,
  durationMs: unknown,
): PiEntryTimes {
  const entryAt = parseIsoMs(entryTimestamp)
  const msgAt = parseEpochMs(messageTimestamp)
  const duration = nonNegNum(durationMs)

  let sentAt: number | null = msgAt
  let endedAt: number | null = entryAt

  if (sentAt === null && endedAt !== null && duration !== null) {
    sentAt = Math.max(0, Math.round(endedAt - duration))
  }
  if (endedAt === null && sentAt !== null && duration !== null) {
    endedAt = Math.round(sentAt + duration)
  }
  if (sentAt !== null && endedAt !== null && endedAt < sentAt) {
    // Guard against clock skew between message and entry timestamps.
    endedAt = duration !== null ? Math.round(sentAt + duration) : sentAt
  }
  if (sentAt === null && endedAt !== null) {
    // Older logs with only one timestamp carry no separate start time.
    sentAt = endedAt
  }
  return { sentAt, endedAt, at: endedAt ?? sentAt }
}

/** Extracts the session id and working directory from a Pi `session` header record. */
export function parsePiSessionHeader(
  record: Rec,
): { id: string | null; cwd: string | null } | null {
  if (record.type !== 'session') return null
  return {
    id: nonEmpty(record.id),
    cwd: nonEmpty(record.cwd),
  }
}

/** Extracts the session id suffix from a Pi session filename (`<timestamp>_<id>.jsonl`). */
export function sessionIdFromPiFile(file: string): string | null {
  const name = path.basename(file)
  if (!name.endsWith('.jsonl')) return null
  const stem = name.slice(0, -'.jsonl'.length)
  const split = stem.indexOf('_')
  const id = (split === -1 ? stem : stem.slice(split + 1)).trim()
  return id !== '' ? id : null
}
