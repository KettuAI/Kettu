import { parseDiffFromFile } from '@pierre/diffs'
import type { ChangedFile, FileDiff } from '@shared/git'

/** Maximum diff lines rendered inside a file row's inline preview before truncating. */
export const INLINE_DIFF_MAX_LINES = 200

/** Maximum combined text length parsed inline before falling back or truncating. */
export const INLINE_DIFF_MAX_CHARS = 200_000

/** Maximum single-line length accepted in a fast-truncated inline slice (guards minified files). */
const INLINE_DIFF_MAX_SLICE_CHARS = 120_000

/** Every visual state an expanded inline diff region can show. */
export type InlineDiffView =
  | { kind: 'loading' }
  | { kind: 'error'; error: string }
  | { kind: 'binary' }
  | { kind: 'too-large' }
  | { kind: 'renamed-only'; oldPath: string; path: string }
  | { kind: 'empty-added' }
  | { kind: 'empty-deleted' }
  | { kind: 'empty' }
  | {
      kind: 'diff'
      oldText: string | null
      newText: string
      truncated: boolean
      shownLines: number
      totalLines: number | null
    }

/** Toggles one file path's expanded state without affecting other expanded files. */
export function toggleExpandedPath(open: ReadonlySet<string>, path: string): ReadonlySet<string> {
  const next = new Set(open)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  return next
}

/** Drops expanded paths that are no longer present in the current change list. */
export function pruneExpandedPaths(
  open: ReadonlySet<string>,
  files: readonly Pick<ChangedFile, 'path'>[],
): ReadonlySet<string> {
  if (open.size === 0) return open
  const present = new Set(files.map((file) => file.path))
  let changed = false
  for (const path of open) {
    if (!present.has(path)) {
      changed = true
      break
    }
  }
  if (!changed) return open
  const next = new Set<string>()
  for (const path of open) {
    if (present.has(path)) next.add(path)
  }
  return next
}

function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

function joinLines(lines: readonly string[], start: number, end: number): string {
  return lines.slice(Math.max(0, start), Math.max(0, end)).join('\n')
}

/**
 * Classifies a working-tree file diff for inline rendering and truncates oversized diffs so
 * expanding a large file keeps the Git pane responsive while offering the full diff tab.
 */
export function prepareInlineDiff(
  file: Pick<ChangedFile, 'path' | 'oldPath' | 'status'>,
  data: FileDiff | null,
  error: string | null,
): InlineDiffView {
  if (!data) {
    return error ? { kind: 'error', error } : { kind: 'loading' }
  }
  if (data.binary) return { kind: 'binary' }
  if (data.tooLarge) return { kind: 'too-large' }

  const { oldText, newText } = data
  if (file.status === 'renamed' && file.oldPath && oldText === newText) {
    return { kind: 'renamed-only', oldPath: file.oldPath, path: file.path }
  }
  if (
    (file.status === 'added' || file.status === 'untracked') &&
    oldText === null &&
    (newText ?? '') === ''
  ) {
    return { kind: 'empty-added' }
  }
  if (file.status === 'deleted' && (oldText ?? '') === '' && newText === null) {
    return { kind: 'empty-deleted' }
  }
  if (oldText === newText || (oldText ?? '') === (newText ?? '')) {
    return { kind: 'empty' }
  }

  // Added / untracked file: slice directly by line count.
  if (oldText === null && newText !== null) {
    const lines = splitLines(newText)
    const slice = lines.slice(0, INLINE_DIFF_MAX_LINES).join('\n')
    if (slice.length > INLINE_DIFF_MAX_SLICE_CHARS) return { kind: 'too-large' }
    const truncated = lines.length > INLINE_DIFF_MAX_LINES
    return {
      kind: 'diff',
      oldText: null,
      newText: truncated ? slice : newText,
      truncated,
      shownLines: truncated ? INLINE_DIFF_MAX_LINES : lines.length,
      totalLines: lines.length,
    }
  }

  // Deleted file: slice old text directly by line count.
  if (oldText !== null && newText === null) {
    const lines = splitLines(oldText)
    const slice = lines.slice(0, INLINE_DIFF_MAX_LINES).join('\n')
    if (slice.length > INLINE_DIFF_MAX_SLICE_CHARS) return { kind: 'too-large' }
    const truncated = lines.length > INLINE_DIFF_MAX_LINES
    return {
      kind: 'diff',
      oldText: truncated ? slice : oldText,
      newText: '',
      truncated,
      shownLines: truncated ? INLINE_DIFF_MAX_LINES : lines.length,
      totalLines: lines.length,
    }
  }

  const before = oldText ?? ''
  const after = newText ?? ''

  // Guard against huge files (e.g. minified bundles) before running a full line diff.
  if (before.length + after.length > INLINE_DIFF_MAX_CHARS) {
    const oldLines = splitLines(before)
    const newLines = splitLines(after)
    const oldSlice = oldLines.slice(0, INLINE_DIFF_MAX_LINES).join('\n')
    const newSlice = newLines.slice(0, INLINE_DIFF_MAX_LINES).join('\n')
    if (oldSlice.length + newSlice.length > INLINE_DIFF_MAX_SLICE_CHARS || oldSlice === newSlice) {
      return { kind: 'too-large' }
    }
    return {
      kind: 'diff',
      oldText: oldSlice,
      newText: newSlice,
      truncated: true,
      shownLines: INLINE_DIFF_MAX_LINES,
      totalLines: null,
    }
  }

  const parsed = parseDiffFromFile(
    { name: file.path, contents: before },
    { name: file.path, contents: after },
  )
  if (parsed.hunks.length === 0) return { kind: 'empty' }

  const totalLines = parsed.hunks.reduce((sum, hunk) => sum + hunk.unifiedLineCount, 0)
  if (totalLines <= INLINE_DIFF_MAX_LINES) {
    return {
      kind: 'diff',
      oldText: before,
      newText: after,
      truncated: false,
      shownLines: totalLines,
      totalLines,
    }
  }

  // Keep complete leading hunks that fit within the budget; if the first hunk alone exceeds it,
  // trim both sides near the start of that hunk so line numbers stay faithful.
  const oldLines = splitLines(before)
  const newLines = splitLines(after)
  let keptLines = 0
  let lastKeptIndex = -1
  for (let i = 0; i < parsed.hunks.length; i++) {
    const hunk = parsed.hunks[i]!
    if (keptLines + hunk.unifiedLineCount > INLINE_DIFF_MAX_LINES) break
    keptLines += hunk.unifiedLineCount
    lastKeptIndex = i
  }

  if (lastKeptIndex >= 0) {
    const last = parsed.hunks[lastKeptIndex]!
    const oldEnd = last.deletionStart - 1 + last.deletionCount
    const newEnd = last.additionStart - 1 + last.additionCount
    return {
      kind: 'diff',
      oldText: joinLines(oldLines, 0, oldEnd),
      newText: joinLines(newLines, 0, newEnd),
      truncated: true,
      shownLines: keptLines,
      totalLines,
    }
  }

  const first = parsed.hunks[0]!
  const sideBudget = Math.ceil(INLINE_DIFF_MAX_LINES / 2)
  const oldEnd = first.deletionStart - 1 + Math.min(first.deletionCount, sideBudget)
  const newEnd = first.additionStart - 1 + Math.min(first.additionCount, sideBudget)
  let oldSlice = joinLines(oldLines, 0, oldEnd)
  let newSlice = joinLines(newLines, 0, newEnd)
  // Ensure the truncated prefix still reflects a visible difference.
  if (oldSlice === newSlice) {
    oldSlice = joinLines(
      oldLines,
      0,
      first.deletionStart - 1 + Math.min(first.deletionCount, INLINE_DIFF_MAX_LINES),
    )
    newSlice = joinLines(
      newLines,
      0,
      first.additionStart - 1 + Math.min(first.additionCount, INLINE_DIFF_MAX_LINES),
    )
  }
  if (oldSlice === newSlice) return { kind: 'too-large' }

  return {
    kind: 'diff',
    oldText: oldSlice,
    newText: newSlice,
    truncated: true,
    shownLines: INLINE_DIFF_MAX_LINES,
    totalLines,
  }
}
