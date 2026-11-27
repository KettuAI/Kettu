// Parses and normalizes Codex configuration warnings (`configWarning` notifications and
// configuration-related `warning` notifications) into structured notice entries.

import type { ConfigWarningDetail, ConfigWarningSource, ThreadEntry } from '@shared/thread'
import { t } from '../i18n'
import type { ConfigWarningNotification, TextPosition, TextRange } from './protocol'

type NoticeEntry = Extract<ThreadEntry, { kind: 'notice' }>

/** Official Codex configuration reference documentation. */
export const CODEX_CONFIG_DOCS_URL = 'https://developers.openai.com/codex/config-reference'

/** Context from the Codex connection used to recognize known config layers without guessing. */
export interface CodexConfigWarningContext {
  /** Absolute `codexHome` directory reported by `initialize`, when available. */
  codexHome?: string | null
  /** Working directory of the Codex thread, when available. */
  cwd?: string | null
}

const WINDOWS_DRIVE_PATH = /^[a-z]:[\\/]/i
const WINDOWS_PREFIX = /^[a-z]:/i
const TILDE_PATH = /^~[\\/]/
const LINE_COL_SUFFIX = /^(.*?):(\d+)(?::(\d+))?$/

// Structured source lines emitted by Codex's config loader, e.g.:
// `  user (/Users/alice/.codex/config.toml): `disable_response_storage` is ignored.`
// `  project (/repo/.codex/config.toml): `foo` is ignored.`
const LAYER_SOURCE_LINE = /^\s*(user|project|system|profile|managed|mdm)\s*\(([^()\r\n]+)\)\s*:/gim

// Patterns matching Codex configuration warnings when delivered via a thread `warning` notification.
const CONFIG_WARNING_PATTERNS: readonly RegExp[] = [
  /\bCodex is ignoring \d+ unrecognized configuration settings?\b/i,
  /\bInvalid configuration;\s*using defaults\b/i,
  /\bFailed to (?:load|parse) (?:Codex )?config(?:uration)?\b/i,
  /`\[[a-z0-9_.-]+\]\.[a-z0-9_.-]+`\s+is\s+(?:deprecated|ignored|removed|no longer supported)\b/i,
  /\b(?:feature flag|configuration setting|config key|config setting)\b[^\r\n]*\b(?:deprecated|ignored|removed)\b/i,
  /\b(?:deprecated|ignored|removed)\b[^\r\n]*\bconfig\.toml\b/i,
  /^\s*(?:user|project|system|profile|managed|mdm)\s*\([^()\r\n]*config\.toml\)\s*:/im,
]

const INVALID_IMPACT_PATTERNS: readonly RegExp[] = [
  /\bInvalid configuration;\s*using defaults\b/i,
  /\bFailed to (?:load|parse) (?:Codex )?config(?:uration)?\b/i,
  /\b(?:toml parse error|syntax error|invalid toml|falling back to defaults)\b/i,
]

// Checked before `deprecated`, because Codex's ignored-setting message includes the phrase
// "Check for typos or deprecated settings." even though the setting itself is ignored.
const IGNORED_IMPACT_PATTERNS: readonly RegExp[] = [
  /\bCodex is ignoring \d+ unrecognized configuration settings?\b/i,
  /\bis ignored\b/i,
  /\b(?:unrecognized configuration setting|unknown configuration key)\b/i,
  /\b(?:has been removed|no longer supported)\b[^\r\n]*\bignored\b/i,
]

const DEPRECATED_IMPACT_PATTERNS: readonly RegExp[] = [/\bis deprecated\b/i, /\bdeprecated\b/i]

function normalizeForCompare(filePath: string): string {
  const unified = filePath.replace(/\\/g, '/').replace(/\/+$/, '')
  return WINDOWS_PREFIX.test(unified) ? unified.toLowerCase() : unified
}

function isRecognizedConfigPath(candidate: string): boolean {
  if (!candidate || candidate.includes('\0')) return false
  if (candidate.startsWith('/') && !candidate.startsWith('//')) return true
  if (WINDOWS_DRIVE_PATH.test(candidate)) return true
  if (TILDE_PATH.test(candidate)) return true
  return false
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined
}

function parsePosition(value: unknown): TextPosition | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.line !== 'number' || typeof record.column !== 'number') return null
  return { line: record.line, column: record.column }
}

function parseRange(value: unknown): TextRange | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const start = parsePosition(record.start)
  const end = parsePosition(record.end)
  return start && end ? { start, end } : null
}

/** Parses raw JSON-RPC `configWarning` parameters into a typed notification, or null if empty. */
export function parseConfigWarningNotification(params: unknown): ConfigWarningNotification | null {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null
  const record = params as Record<string, unknown>
  const summary = typeof record.summary === 'string' ? record.summary.trim() : ''
  const details =
    typeof record.details === 'string' && record.details.trim() ? record.details.trim() : null
  if (!summary && !details) return null
  const filePath = typeof record.path === 'string' && record.path.trim() ? record.path.trim() : null
  const range = parseRange(record.range)
  const threadId =
    typeof record.threadId === 'string' && record.threadId.trim() ? record.threadId.trim() : null
  return {
    summary: summary || details!,
    details: summary ? details : null,
    ...(filePath ? { path: filePath } : {}),
    ...(range ? { range } : {}),
    ...(threadId ? { threadId } : {}),
  }
}

/** Whether a `warning` notification message is clearly a Codex configuration warning. */
export function isCodexConfigWarningMessage(message: string): boolean {
  const trimmed = message.trim()
  if (!trimmed) return false
  return CONFIG_WARNING_PATTERNS.some((pattern) => pattern.test(trimmed))
}

/** Classifies whether a Codex configuration warning is invalid, ignored, or deprecated-but-active. */
export function classifyConfigWarningImpact(
  summary: string,
  details?: string | null,
): ConfigWarningDetail['impact'] {
  const combined = details ? `${summary}\n${details}` : summary
  if (INVALID_IMPACT_PATTERNS.some((pattern) => pattern.test(combined))) return 'invalid'
  if (IGNORED_IMPACT_PATTERNS.some((pattern) => pattern.test(combined))) return 'ignored'
  if (DEPRECATED_IMPACT_PATTERNS.some((pattern) => pattern.test(combined))) return 'deprecated'
  return undefined
}

/** Infers the configuration layer only when the path unambiguously matches a known Codex layer. */
function inferConfigLayer(
  filePath: string,
  context?: CodexConfigWarningContext,
): string | undefined {
  const normalized = normalizeForCompare(filePath)
  const codexHome = context?.codexHome?.trim()
  if (codexHome) {
    const homeNorm = normalizeForCompare(codexHome)
    if (normalized === `${homeNorm}/config.toml`) return 'user'
    if (normalized.startsWith(`${homeNorm}/`) && normalized.endsWith('.config.toml')) {
      const rest = normalized.slice(homeNorm.length + 1)
      if (!rest.includes('/')) return 'profile'
    }
  }
  if (normalized === '~/.codex/config.toml') return 'user'
  if (
    normalized === '/etc/codex/config.toml' ||
    /\/programdata\/openai\/codex\/config\.toml$/i.test(normalized)
  ) {
    return 'system'
  }
  const cwd = context?.cwd?.trim()
  if (cwd) {
    const cwdNorm = normalizeForCompare(cwd)
    if (
      normalized === `${cwdNorm}/.codex/config.toml` ||
      (normalized.startsWith(`${cwdNorm}/`) && normalized.endsWith('/.codex/config.toml'))
    ) {
      return 'project'
    }
  }
  if (/^(?:\/(?:users|home)|[a-z]:\/users)\/[^/]+\/\.codex\/config\.toml$/i.test(normalized)) {
    return 'user'
  }
  return undefined
}

function splitPathAndPosition(
  raw: string,
): { path: string; line?: number; column?: number } | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  // Check for `:line` or `:line:column` suffix without splitting a Windows drive letter (`C:\...`).
  const match = LINE_COL_SUFFIX.exec(trimmed)
  if (match && isRecognizedConfigPath(match[1]!)) {
    const line = positiveInt(Number(match[2]))
    const column = match[3] !== undefined ? positiveInt(Number(match[3])) : undefined
    return {
      path: match[1]!,
      ...(line !== undefined ? { line } : {}),
      ...(column !== undefined ? { column } : {}),
    }
  }
  if (!isRecognizedConfigPath(trimmed)) return null
  return { path: trimmed }
}

/**
 * Extracts concrete configuration file sources reported by Codex (`params.path`/`params.range`
 * and explicit `layer (path):` lines in the message). Never guesses a path when none was reported.
 */
export function extractConfigWarningSources(
  warning: Pick<ConfigWarningNotification, 'summary' | 'details' | 'path' | 'range'>,
  context?: CodexConfigWarningContext,
): ConfigWarningSource[] {
  const sources: ConfigWarningSource[] = []
  const byKey = new Map<string, ConfigWarningSource>()

  const addSource = (candidate: ConfigWarningSource): void => {
    const key = normalizeForCompare(candidate.path)
    const existing = byKey.get(key)
    if (existing) {
      if (!existing.layer && candidate.layer) existing.layer = candidate.layer
      if (existing.line === undefined && candidate.line !== undefined)
        existing.line = candidate.line
      if (existing.column === undefined && candidate.column !== undefined) {
        existing.column = candidate.column
      }
      return
    }
    const copy: ConfigWarningSource = {
      ...(candidate.layer ? { layer: candidate.layer } : {}),
      path: candidate.path,
      ...(candidate.line !== undefined ? { line: candidate.line } : {}),
      ...(candidate.column !== undefined ? { column: candidate.column } : {}),
    }
    byKey.set(key, copy)
    sources.push(copy)
  }

  if (typeof warning.path === 'string' && warning.path.trim()) {
    const parsed = splitPathAndPosition(warning.path)
    if (parsed) {
      const line = positiveInt(warning.range?.start.line) ?? parsed.line
      const column = positiveInt(warning.range?.start.column) ?? parsed.column
      const layer = inferConfigLayer(parsed.path, context)
      addSource({
        ...(layer ? { layer } : {}),
        path: parsed.path,
        ...(line !== undefined ? { line } : {}),
        ...(column !== undefined ? { column } : {}),
      })
    }
  }

  const text = warning.details ? `${warning.summary}\n${warning.details}` : warning.summary
  LAYER_SOURCE_LINE.lastIndex = 0
  for (const match of text.matchAll(LAYER_SOURCE_LINE)) {
    const layer = match[1]!.toLowerCase()
    const parsed = splitPathAndPosition(match[2]!)
    if (!parsed) continue
    addSource({
      layer,
      path: parsed.path,
      ...(parsed.line !== undefined ? { line: parsed.line } : {}),
      ...(parsed.column !== undefined ? { column: parsed.column } : {}),
    })
  }

  return sources
}

/** Stable deduplication key for suppressing duplicate config warnings within one Codex thread. */
export function configWarningDedupeKey(
  warning: Pick<ConfigWarningNotification, 'summary' | 'details' | 'path'>,
): string {
  const summary = warning.summary.trim()
  const details = warning.details?.trim() ?? ''
  const filePath = warning.path?.trim() ?? ''
  return `${summary}\0${details}\0${filePath}`
}

/** Builds a backward-compatible `notice` entry with structured `configWarning` metadata. */
export function buildCodexConfigWarningNotice(
  warning: ConfigWarningNotification,
  id: string,
  context?: CodexConfigWarningContext,
): NoticeEntry | null {
  const summary = warning.summary.trim()
  const details = warning.details?.trim() || undefined
  if (!summary && !details) return null

  const description =
    summary && details && !summary.includes(details)
      ? `${summary}\n${details}`
      : (summary || details)!
  const impact = classifyConfigWarningImpact(summary, details)
  const sources = extractConfigWarningSources(warning, context)

  const detail: ConfigWarningDetail = {
    agent: 'codex',
    ...(impact ? { impact } : {}),
    ...(sources.length > 0 ? { sources } : {}),
    ...(details && summary && !summary.includes(details) ? { details } : {}),
    docsUrl: CODEX_CONFIG_DOCS_URL,
  }

  return {
    kind: 'notice',
    id,
    severity: 'warning',
    title: t('codex.notice.configWarning'),
    description,
    configWarning: detail,
  }
}
