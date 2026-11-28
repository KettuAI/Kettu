// Pure helpers for the composer's `#` GitHub issue and pull request picker: trigger detection
// with Markdown heading / code guards, local filtering and ranking, and standard reference insertion.

import { inlineCodeSpans, type RepositoryReferenceItem } from '@shared/git'
import { startsWord } from './trigger'

/** Maximum rows shown in the `#` issue/PR picker popover. */
export const GITHUB_REF_LIMIT = 30

export interface HashTrigger {
  /** Index of the `#` character in the composer text. */
  start: number
  /** Characters typed after `#` up to the caret. */
  query: string
}

export interface GitHubRefRow {
  githubRef: true
  item: RepositoryReferenceItem
  /** Matched UTF-16 positions inside `#<number>` (0 is `#`). */
  numberMatches: number[]
  /** Matched UTF-16 positions inside `item.title`. */
  titleMatches: number[]
}

const OPENING_FENCE = /^([ ]{0,3})(`{3,}|~{3,})([^\r\n]*)$/
// Characters inside `#query` that mean the user is typing Markdown headings (`##`), paths, or code.
const INVALID_HASH_QUERY = /[#/:\\`]/

function parseFenceOpen(line: string): { char: '`' | '~'; length: number } | null {
  const match = OPENING_FENCE.exec(line)
  if (!match) return null
  const fence = match[2]!
  const char = fence[0] as '`' | '~'
  const info = match[3]!.trim()
  if (char === '`' && info.includes('`')) return null
  return { char, length: fence.length }
}

function isFenceClose(line: string, char: '`' | '~', minLength: number): boolean {
  let i = 0
  let spaces = 0
  while (i < line.length && line[i] === ' ' && spaces < 3) {
    i++
    spaces++
  }
  let count = 0
  while (i < line.length && line[i] === char) {
    i++
    count++
  }
  if (count < minLength) return false
  while (i < line.length) {
    if (line[i] !== ' ' && line[i] !== '\t') return false
    i++
  }
  return true
}

/**
 * Returns whether character offset `pos` in `text` falls inside an open or closed fenced code block
 * (3+ backticks or tildes at line start). Used to suppress `#` triggers and `#123` chips in code.
 */
export function isInsideCodeFence(text: string, pos: number): boolean {
  if (!text.includes('```') && !text.includes('~~~')) return false
  const limit = Math.max(0, Math.min(pos, text.length))
  let open: { char: '`' | '~'; length: number } | null = null
  let lineStart = 0
  while (lineStart <= limit) {
    let lineEnd = text.indexOf('\n', lineStart)
    if (lineEnd < 0) lineEnd = text.length
    const contentEnd = lineEnd > lineStart && text[lineEnd - 1] === '\r' ? lineEnd - 1 : lineEnd
    const content = text.slice(lineStart, contentEnd)
    const onThisLine = limit <= lineEnd
    if (!open) {
      const opened = parseFenceOpen(content)
      if (opened) {
        if (onThisLine) return true
        open = opened
      } else if (onThisLine) {
        return false
      }
    } else {
      if (isFenceClose(content, open.char, open.length)) {
        if (onThisLine) return true
        open = null
      } else if (onThisLine) {
        return true
      }
    }
    if (lineEnd === text.length) break
    lineStart = lineEnd + 1
  }
  return open !== null
}

/**
 * Computes the set of 1-based line numbers inside fenced code blocks (including fence delimiter
 * lines) so the editor can skip `#123` chip decoration inside code blocks.
 */
export function fencedCodeLines(text: string): ReadonlySet<number> {
  const lines = new Set<number>()
  if (!text.includes('```') && !text.includes('~~~')) return lines
  let open: { char: '`' | '~'; length: number } | null = null
  let lineNumber = 1
  let lineStart = 0
  while (lineStart <= text.length) {
    let lineEnd = text.indexOf('\n', lineStart)
    if (lineEnd < 0) lineEnd = text.length
    const contentEnd = lineEnd > lineStart && text[lineEnd - 1] === '\r' ? lineEnd - 1 : lineEnd
    const content = text.slice(lineStart, contentEnd)
    if (!open) {
      const opened = parseFenceOpen(content)
      if (opened) {
        lines.add(lineNumber)
        open = opened
      }
    } else {
      lines.add(lineNumber)
      if (isFenceClose(content, open.char, open.length)) open = null
    }
    if (lineEnd === text.length) break
    lineStart = lineEnd + 1
    lineNumber++
  }
  return lines
}

/**
 * The active `#query` GitHub reference trigger at `caret`, or null when the caret is not on a
 * word-leading `#` (or is inside code, after whitespace like `# Heading`, or in `## Heading`).
 */
export function hashRefAt(text: string, caret: number | null): HashTrigger | null {
  if (caret === null || caret < 1 || caret > text.length) return null
  // Walk back to the start of the current whitespace-delimited token.
  let at = caret - 1
  while (at >= 0 && !/\s/.test(text[at]!)) {
    if (text[at] === '#') {
      if (!startsWord(text, at) || (at > 0 && text[at - 1] === '#')) return null
      const query = text.slice(at + 1, caret)
      if (INVALID_HASH_QUERY.test(query)) return null
      if (isInsideCodeFence(text, at)) return null
      if (inlineCodeSpans(text).some((span) => at >= span.from && caret <= span.to)) return null
      return { start: at, query }
    }
    at--
  }
  return null
}

/**
 * Whether the `#` picker should show for `trigger`: hidden once Esc dismissed this `#` or while an
 * IME composition starts before the picker was already open.
 */
export function hashPickerShown(
  trigger: HashTrigger | null,
  dismissed: number | null,
  composition: { open: boolean } | null,
): boolean {
  return trigger !== null && trigger.start !== dismissed && (composition?.open ?? true)
}

/**
 * Replaces `#query` up to the caret with a canonical GitHub reference URL followed by a trailing
 * space (reusing an existing space after the caret), preserving all surrounding text.
 */
export function replaceHashRef(
  text: string,
  trigger: HashTrigger,
  url: string,
): { text: string; caret: number } {
  const before = `${text.slice(0, trigger.start)}${url}`
  const after = text.slice(trigger.start + 1 + trigger.query.length)
  const next = after.startsWith(' ') ? `${before}${after}` : `${before} ${after}`
  return { text: next, caret: before.length + 1 }
}

function rangePositions(start: number, length: number): number[] {
  const out: number[] = []
  for (let i = 0; i < length; i++) out.push(start + i)
  return out
}

function matchTitle(
  title: string,
  queryLower: string,
): { score: number; positions: number[] } | null {
  const lower = title.toLowerCase()
  const idx = lower.indexOf(queryLower)
  if (idx >= 0) {
    const atBoundary = idx === 0 || /[\s\-_/:([\]]/.test(lower[idx - 1]!)
    return { score: atBoundary ? 400 : 300, positions: rangePositions(idx, queryLower.length) }
  }
  return null
}

/**
 * Deduplicates, filters, and ranks repository issues and pull requests for `query` (by number or
 * title). Higher-priority number matches come first, then title matches, then newest updated.
 */
export function filterAndRankReferences(
  items: readonly RepositoryReferenceItem[],
  query: string,
  limit = GITHUB_REF_LIMIT,
): GitHubRefRow[] {
  const byNumber = new Map<number, RepositoryReferenceItem>()
  for (const item of items) {
    if (!byNumber.has(item.number)) byNumber.set(item.number, item)
  }
  const unique = [...byNumber.values()]
  const trimmed = query.trim()
  if (!trimmed) {
    return unique
      .sort((a, b) => b.updatedAt - a.updatedAt || b.number - a.number)
      .slice(0, limit)
      .map((item) => ({ githubRef: true, item, numberMatches: [], titleMatches: [] }))
  }
  const queryLower = trimmed.toLowerCase()
  const numeric = /^\d+$/.test(trimmed)
  const ranked: { row: GitHubRefRow; score: number }[] = []
  for (const item of unique) {
    const numStr = String(item.number)
    let score = 0
    let numberMatches: number[] = []
    let titleMatches: number[] = []
    if (numeric) {
      if (numStr === trimmed) {
        score = 1000
        // Offset by 1 because the rendered token is `#<number>`.
        numberMatches = rangePositions(1, numStr.length)
      } else if (numStr.startsWith(trimmed)) {
        score = 800
        numberMatches = rangePositions(1, trimmed.length)
      } else {
        const numIdx = numStr.indexOf(trimmed)
        if (numIdx >= 0) {
          score = 600
          numberMatches = rangePositions(1 + numIdx, trimmed.length)
        }
      }
    }
    const titleHit = matchTitle(item.title, queryLower)
    if (titleHit) {
      score = Math.max(score, titleHit.score)
      titleMatches = titleHit.positions
    }
    if (score > 0) {
      ranked.push({
        score,
        row: { githubRef: true, item, numberMatches, titleMatches },
      })
    }
  }
  ranked.sort(
    (a, b) =>
      b.score - a.score ||
      b.row.item.updatedAt - a.row.item.updatedAt ||
      b.row.item.number - a.row.item.number,
  )
  return ranked.slice(0, limit).map((entry) => entry.row)
}
