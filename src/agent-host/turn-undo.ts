// Safe preview and all-or-nothing reversal of a single turn's file changes.

import { createHash, randomBytes } from 'node:crypto'
import type { Stats } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, rmdir, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { FILE_READ_LIMIT } from '@shared/files'
import type { Platform } from '@shared/platform'
import type { ToolEntry } from '@shared/thread'
import type {
  TurnUndoAction,
  TurnUndoConflict,
  TurnUndoFileDigest,
  TurnUndoFilePreview,
  TurnUndoFileStatus,
  TurnUndoPreview,
  TurnUndoReason,
  TurnUndoResult,
} from '@shared/turn-undo'
import { isAbsolutePath, pathKey } from './paths'

const BINARY_PROBE_BYTES = 8_000
const HUNK_CONTEXT_LINES = 3
const MAX_MYERS_D = 1_500
const MAX_DIFF_LINES = 20_000
const RENAME_REFUSED: ReadonlySet<string> = new Set(['EPERM', 'EACCES', 'EBUSY'])

const utf8Strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function toLf(text: string): string {
  return text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text
}

function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function isBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)
}

function detectLineEnding(rawText: string): '\r\n' | '\n' {
  if (!rawText.includes('\r\n')) return '\n'
  const stripped = rawText.replace(/\r\n/g, '')
  return stripped.includes('\n') ? '\n' : '\r\n'
}

function applyLineEnding(lfText: string, eol: '\r\n' | '\n'): string {
  return eol === '\r\n' ? lfText.replace(/\n/g, '\r\n') : lfText
}

function isGone(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function withinRoot(outer: string, inner: string, platform: Platform): boolean {
  const api = platform === 'win32' ? path.win32 : path.posix
  const outerKey = pathKey(outer, platform)
  const innerKey = pathKey(inner, platform)
  const prefix = outerKey.endsWith(api.sep) ? outerKey : outerKey + api.sep
  return innerKey === outerKey || innerKey.startsWith(prefix)
}

function hasReplaceAll(rawInput: string | undefined): boolean {
  if (!rawInput || !rawInput.includes('replace_all')) return false
  try {
    const parsed = JSON.parse(rawInput) as unknown
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as Record<string, unknown>).replace_all === true
    )
  } catch {
    return false
  }
}

type FileOp =
  | { kind: 'create'; newText: string }
  | { kind: 'delete'; oldText: string | null }
  | { kind: 'edit'; oldText: string; newText: string }
  | { kind: 'unsupported'; reason: TurnUndoReason }

interface CollectedFile {
  /** Canonical key for merging multiple ops on the same file within one turn. */
  key: string
  /** Workspace-relative '/'-separated path when valid, else the raw recorded path. */
  path: string
  /** First path string recorded in the turn's tool entries. */
  displayPath: string
  /** Whether the logical path stays within the workspace and outside `.git`. */
  pathValid: boolean
  /** Reason if `pathValid` is false. */
  pathReason?: TurnUndoReason
  ops: FileOp[]
}

function normalizeLogicalPath(
  workRoot: string,
  rawPath: string,
  platform: Platform,
): { ok: true; relative: string } | { ok: false; reason: TurnUndoReason } {
  const api = platform === 'win32' ? path.win32 : path.posix
  if (rawPath === '' || rawPath.includes('\0')) {
    return { ok: false, reason: 'outside_workspace' }
  }
  const resolvedRoot = api.resolve(workRoot)
  let resolvedTarget: string
  if (isAbsolutePath(rawPath, platform)) {
    resolvedTarget = api.resolve(rawPath)
  } else {
    if (platform === 'win32' && rawPath.includes(':')) {
      return { ok: false, reason: 'outside_workspace' }
    }
    resolvedTarget = api.resolve(resolvedRoot, rawPath)
  }
  if (!withinRoot(resolvedRoot, resolvedTarget, platform)) {
    return { ok: false, reason: 'outside_workspace' }
  }
  const rel = api.relative(resolvedRoot, resolvedTarget)
  if (rel === '' || rel === '.' || rel.startsWith('..') || isAbsolutePath(rel, platform)) {
    return { ok: false, reason: 'outside_workspace' }
  }
  const segments = rel.split(platform === 'win32' ? /[\\/]/ : '/').filter(Boolean)
  if (segments.length === 0 || segments.includes('..') || segments.includes('.git')) {
    return { ok: false, reason: 'outside_workspace' }
  }
  return { ok: true, relative: segments.join('/') }
}

/** Collects per-file operations in chronological order from one turn's completed tool entries. */
export function collectTurnFileOps(
  entries: readonly ToolEntry[],
  workRoot: string,
  platform: Platform,
): CollectedFile[] {
  const byKey = new Map<string, CollectedFile>()

  const getOrAdd = (rawPath: string): CollectedFile => {
    const normalized = normalizeLogicalPath(workRoot, rawPath, platform)
    const logicalPath = normalized.ok ? normalized.relative : rawPath
    const key = normalized.ok
      ? `rel:${platform === 'win32' ? logicalPath.toLowerCase() : logicalPath}`
      : `raw:${rawPath}`
    let item = byKey.get(key)
    if (!item) {
      item = {
        key,
        path: logicalPath,
        displayPath: rawPath,
        pathValid: normalized.ok,
        ...(normalized.ok ? {} : { pathReason: normalized.reason }),
        ops: [],
      }
      byKey.set(key, item)
    }
    return item
  }

  for (const entry of entries) {
    if (entry.kind !== 'tool' || entry.status !== 'completed') continue
    const diffs = entry.content.filter(
      (item): item is Extract<(typeof entry.content)[number], { type: 'diff' }> =>
        item.type === 'diff',
    )
    const replaceAll = hasReplaceAll(entry.rawInput)

    if (diffs.length > 0) {
      for (const diff of diffs) {
        const file = getOrAdd(diff.path)
        if (replaceAll) {
          file.ops.push({ kind: 'unsupported', reason: 'replace_all_unsupported' })
        } else if (diff.oldText === null) {
          file.ops.push({ kind: 'create', newText: toLf(diff.newText) })
        } else if (entry.toolKind === 'delete') {
          file.ops.push({ kind: 'delete', oldText: toLf(diff.oldText) })
        } else {
          file.ops.push({
            kind: 'edit',
            oldText: toLf(diff.oldText),
            newText: toLf(diff.newText),
          })
        }
      }
      continue
    }

    if (entry.toolKind === 'delete') {
      for (const loc of entry.locations) {
        const file = getOrAdd(loc.path)
        file.ops.push({ kind: 'unsupported', reason: 'missing_before_snapshot' })
      }
    } else if (entry.toolKind === 'move') {
      for (const loc of entry.locations) {
        const file = getOrAdd(loc.path)
        file.ops.push({ kind: 'unsupported', reason: 'unsupported_operation' })
      }
    } else if (entry.toolKind === 'edit') {
      // An edit tool with no diff content on a file already touched in this turn makes its state incomplete.
      for (const loc of entry.locations) {
        const normalized = normalizeLogicalPath(workRoot, loc.path, platform)
        const key = normalized.ok
          ? `rel:${platform === 'win32' ? normalized.relative.toLowerCase() : normalized.relative}`
          : `raw:${loc.path}`
        const existing = byKey.get(key)
        if (existing) {
          existing.ops.push({ kind: 'unsupported', reason: 'missing_before_snapshot' })
        }
      }
    }
  }

  return [...byKey.values()]
}

type TargetCheck =
  | {
      ok: true
      relative: string
      targetPath: string
      exists: boolean
      info: Stats | null
    }
  | {
      ok: false
      relative: string
      reason: TurnUndoReason
    }

/**
 * Validates that `relative` stays strictly inside `realRoot` without crossing any symlink out of
 * the workspace or targeting a symlink or directory directly.
 */
async function resolveSafeTarget(
  realRoot: string,
  relative: string,
  platform: Platform,
): Promise<TargetCheck> {
  const api = platform === 'win32' ? path.win32 : path.posix
  const segments = relative.split('/')
  let current = realRoot

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!
    const isLast = i === segments.length - 1
    const candidate = api.join(current, segment)

    let linkInfo: Stats
    try {
      linkInfo = await lstat(candidate)
    } catch (error) {
      if (isGone(error)) {
        // Remaining segments do not exist on disk; build the non-existent target path under the verified parent.
        const remaining = segments.slice(i)
        return {
          ok: true,
          relative,
          targetPath: api.join(current, ...remaining),
          exists: false,
          info: null,
        }
      }
      throw error
    }

    if (isLast) {
      if (linkInfo.isSymbolicLink()) {
        return { ok: false, relative, reason: 'symlink_not_allowed' }
      }
      if (linkInfo.isDirectory()) {
        return { ok: false, relative, reason: 'directory_in_way' }
      }
      if (!linkInfo.isFile()) {
        return { ok: false, relative, reason: 'unsupported_operation' }
      }
      const realTarget = await realpath(candidate)
      if (!withinRoot(realRoot, realTarget, platform)) {
        return { ok: false, relative, reason: 'outside_workspace' }
      }
      return {
        ok: true,
        relative,
        targetPath: realTarget,
        exists: true,
        info: linkInfo,
      }
    }

    // Intermediate segment must resolve to a directory strictly inside realRoot.
    let realSegment: string
    try {
      realSegment = await realpath(candidate)
    } catch (error) {
      if (isGone(error)) {
        // Broken symlink in path.
        return { ok: false, relative, reason: 'symlink_not_allowed' }
      }
      throw error
    }
    if (!withinRoot(realRoot, realSegment, platform)) {
      return { ok: false, relative, reason: 'outside_workspace' }
    }
    const segStat = await stat(realSegment)
    if (!segStat.isDirectory()) {
      return { ok: false, relative, reason: 'directory_in_way' }
    }
    current = realSegment
  }

  return { ok: false, relative, reason: 'outside_workspace' }
}

interface DiskSnapshot {
  digest: TurnUndoFileDigest
  exists: boolean
  textLf: string | null
  eol: '\r\n' | '\n'
  rawBytes: Buffer | null
  mode: number | null
  nlink: number
  readError?: TurnUndoReason
}

async function readDiskSnapshot(
  target: Extract<TargetCheck, { ok: true }>,
  maxBytes: number,
): Promise<DiskSnapshot> {
  if (!target.exists || target.info === null) {
    return {
      digest: { path: target.relative, exists: false, sha256: null, size: null },
      exists: false,
      textLf: null,
      eol: '\n',
      rawBytes: null,
      mode: null,
      nlink: 0,
    }
  }

  const { size, mode, nlink } = target.info
  if (size > maxBytes) {
    return {
      digest: { path: target.relative, exists: true, sha256: null, size },
      exists: true,
      textLf: null,
      eol: '\n',
      rawBytes: null,
      mode,
      nlink,
      readError: 'too_large',
    }
  }

  const handle = await open(target.targetPath, 'r')
  let bytes: Buffer
  try {
    const buffer = Buffer.allocUnsafe(size)
    let filled = 0
    while (filled < size) {
      const { bytesRead } = await handle.read(buffer, filled, size - filled, filled)
      if (bytesRead === 0) break
      filled += bytesRead
    }
    bytes = buffer.subarray(0, filled)
  } finally {
    await handle.close()
  }

  const digest: TurnUndoFileDigest = {
    path: target.relative,
    exists: true,
    sha256: sha256Hex(bytes),
    size: bytes.length,
  }

  if (isBinary(bytes)) {
    return {
      digest,
      exists: true,
      textLf: null,
      eol: '\n',
      rawBytes: bytes,
      mode,
      nlink,
      readError: 'binary_or_unreadable',
    }
  }

  let decoded: string
  try {
    decoded = utf8Strict.decode(bytes)
  } catch {
    return {
      digest,
      exists: true,
      textLf: null,
      eol: '\n',
      rawBytes: bytes,
      mode,
      nlink,
      readError: 'binary_or_unreadable',
    }
  }

  const eol = detectLineEnding(decoded)
  return {
    digest,
    exists: true,
    textLf: toLf(decoded),
    eol,
    rawBytes: bytes,
    mode,
    nlink,
  }
}

function findAllOccurrences(haystack: string, needle: string): number[] {
  if (needle === '') return []
  const indices: number[] = []
  let from = 0
  while (from <= haystack.length - needle.length) {
    const found = haystack.indexOf(needle, from)
    if (found < 0) break
    indices.push(found)
    from = found + 1
  }
  return indices
}

function isLineBounded(text: string, index: number, length: number): boolean {
  const beforeOk = index === 0 || text[index - 1] === '\n'
  const end = index + length
  const afterOk = end === text.length || text[end] === '\n'
  return beforeOk && afterOk
}

type DiffOp = { type: 'equal' | 'delete' | 'insert'; line: string }

/** Computes a bounded Myers shortest edit script over line arrays; returns null if too large. */
function diffLinesMyers(oldLines: readonly string[], newLines: readonly string[]): DiffOp[] | null {
  let prefix = 0
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix++
  }

  let suffix = 0
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++
  }

  const midOld = oldLines.slice(prefix, oldLines.length - suffix)
  const midNew = newLines.slice(prefix, newLines.length - suffix)

  const n = midOld.length
  const m = midNew.length
  if (n + m > MAX_DIFF_LINES) return null

  const maxD = Math.min(n + m, MAX_MYERS_D)
  const offset = maxD
  const v = new Int32Array(2 * maxD + 1)
  const trace: Int32Array[] = []

  let foundD = -1
  for (let d = 0; d <= maxD; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) {
        x = v[offset + k + 1]!
      } else {
        x = v[offset + k - 1]! + 1
      }
      let y = x - k
      while (x < n && y < m && midOld[x] === midNew[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) {
        foundD = d
        break
      }
    }
    if (foundD >= 0) break
  }

  if (foundD < 0) return null

  const midOps: DiffOp[] = []
  let x = n
  let y = m
  for (let d = foundD; d > 0; d--) {
    const prev = trace[d]!
    const k = x - y
    let prevK: number
    if (k === -d || (k !== d && prev[offset + k - 1]! < prev[offset + k + 1]!)) {
      prevK = k + 1
    } else {
      prevK = k - 1
    }
    const prevX = prev[offset + prevK]!
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      midOps.push({ type: 'equal', line: midOld[x - 1]! })
      x--
      y--
    }
    if (x === prevX) {
      midOps.push({ type: 'insert', line: midNew[y - 1]! })
      y--
    } else {
      midOps.push({ type: 'delete', line: midOld[x - 1]! })
      x--
    }
  }
  while (x > 0 && y > 0) {
    midOps.push({ type: 'equal', line: midOld[x - 1]! })
    x--
    y--
  }
  midOps.reverse()

  const out: DiffOp[] = []
  for (let i = 0; i < prefix; i++) out.push({ type: 'equal', line: oldLines[i]! })
  out.push(...midOps)
  for (let i = oldLines.length - suffix; i < oldLines.length; i++) {
    out.push({ type: 'equal', line: oldLines[i]! })
  }
  return out
}

interface LineHunk {
  oldLines: string[]
  newLines: string[]
  atStart: boolean
  atEnd: boolean
  contextCount: number
}

function buildContextHunks(ops: readonly DiffOp[]): LineHunk[] | null {
  const equalCount = ops.filter((op) => op.type === 'equal').length
  if (equalCount === 0) return null

  const changeIndices: number[] = []
  for (let i = 0; i < ops.length; i++) {
    if (ops[i]!.type !== 'equal') changeIndices.push(i)
  }
  if (changeIndices.length === 0) return []

  // Group changes separated by <= 2 * HUNK_CONTEXT_LINES equal lines into single hunks.
  const ranges: { start: number; end: number }[] = []
  for (const idx of changeIndices) {
    const hStart = Math.max(0, idx - HUNK_CONTEXT_LINES)
    const hEnd = Math.min(ops.length - 1, idx + HUNK_CONTEXT_LINES)
    const prev = ranges.at(-1)
    if (prev && hStart <= prev.end + 1) {
      prev.end = Math.max(prev.end, hEnd)
    } else {
      ranges.push({ start: hStart, end: hEnd })
    }
  }

  const hunks: LineHunk[] = []
  for (const range of ranges) {
    const oldLines: string[] = []
    const newLines: string[] = []
    let contextCount = 0
    for (let i = range.start; i <= range.end; i++) {
      const op = ops[i]!
      if (op.type === 'equal') {
        oldLines.push(op.line)
        newLines.push(op.line)
        contextCount++
      } else if (op.type === 'delete') {
        oldLines.push(op.line)
      } else {
        newLines.push(op.line)
      }
    }
    if (contextCount === 0 || newLines.length === 0) return null
    hunks.push({
      oldLines,
      newLines,
      atStart: range.start === 0,
      atEnd: range.end === ops.length - 1,
      contextCount,
    })
  }
  return hunks
}

function findLineSequenceMatches(
  haystack: readonly string[],
  needle: readonly string[],
  atStart: boolean,
  atEnd: boolean,
): number[] {
  if (needle.length === 0 || needle.length > haystack.length) return []
  const matches: number[] = []
  const minStart = atStart ? 0 : 0
  const maxStart = atStart ? 0 : haystack.length - needle.length
  for (let start = minStart; start <= maxStart; start++) {
    if (atEnd && start + needle.length !== haystack.length) continue
    let ok = true
    for (let j = 0; j < needle.length; j++) {
      if (haystack[start + j] !== needle[j]) {
        ok = false
        break
      }
    }
    if (ok) matches.push(start)
  }
  return matches
}

type ReverseStepResult =
  { ok: true; text: string } | { ok: false; reason: 'content_mismatch' | 'ambiguous_match' }

/**
 * Attempts a strict, context-anchored reverse line patch when an edit's full `newText` does not
 * match verbatim because later edits modified unrelated lines elsewhere in the file.
 */
function reverseLineHunks(
  currentText: string,
  oldText: string,
  newText: string,
): ReverseStepResult {
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')
  const ops = diffLinesMyers(oldLines, newLines)
  if (!ops) return { ok: false, reason: 'content_mismatch' }
  const hunks = buildContextHunks(ops)
  if (!hunks || hunks.length === 0) return { ok: false, reason: 'content_mismatch' }

  const currentLines = currentText.split('\n')
  const matched: { start: number; end: number; oldLines: string[] }[] = []

  for (const hunk of hunks) {
    // Only require start/end anchoring when the original diff itself spanned multiple lines and
    // touched the boundary, so unrelated lines added elsewhere still allow clean matching unless
    // the hunk relies on boundary anchoring (missing leading/trailing context).
    const leadingContext = hunk.atStart && hunk.oldLines[0] !== hunk.newLines[0]
    const trailingContext =
      hunk.atEnd &&
      hunk.oldLines[hunk.oldLines.length - 1] !== hunk.newLines[hunk.newLines.length - 1]
    const hits = findLineSequenceMatches(
      currentLines,
      hunk.newLines,
      leadingContext,
      trailingContext,
    )
    if (hits.length === 0) return { ok: false, reason: 'content_mismatch' }
    if (hits.length > 1) return { ok: false, reason: 'ambiguous_match' }
    const start = hits[0]!
    const end = start + hunk.newLines.length
    const prev = matched.at(-1)
    if (prev && start < prev.end) {
      return { ok: false, reason: 'content_mismatch' }
    }
    matched.push({ start, end, oldLines: hunk.oldLines })
  }

  const out: string[] = []
  let cursor = 0
  for (const item of matched) {
    out.push(...currentLines.slice(cursor, item.start))
    out.push(...item.oldLines)
    cursor = item.end
  }
  out.push(...currentLines.slice(cursor))
  return { ok: true, text: out.join('\n') }
}

/** Reverses a single `oldText -> newText` edit against `currentText` without guessing. */
function reverseSingleEdit(
  currentText: string,
  oldText: string,
  newText: string,
): ReverseStepResult {
  if (oldText === newText) return { ok: true, text: currentText }
  if (newText === '') {
    // Only unambiguous when the entire file was cleared and is still empty.
    if (currentText === '') return { ok: true, text: oldText }
    return { ok: false, reason: 'ambiguous_match' }
  }
  if (currentText === newText) {
    return { ok: true, text: oldText }
  }

  const allHits = findAllOccurrences(currentText, newText)
  if (newText.includes('\n')) {
    const bounded = allHits.filter((idx) => isLineBounded(currentText, idx, newText.length))
    if (bounded.length === 1) {
      const at = bounded[0]!
      return {
        ok: true,
        text: currentText.slice(0, at) + oldText + currentText.slice(at + newText.length),
      }
    }
    if (bounded.length > 1) {
      return { ok: false, reason: 'ambiguous_match' }
    }
  }

  if (allHits.length === 1) {
    const at = allHits[0]!
    return {
      ok: true,
      text: currentText.slice(0, at) + oldText + currentText.slice(at + newText.length),
    }
  }
  if (allHits.length > 1) {
    return { ok: false, reason: 'ambiguous_match' }
  }

  // Exact replacement did not match; try strict context-anchored line hunks for partial-file
  // edits or whole-file writes where unrelated lines changed later.
  return reverseLineHunks(currentText, oldText, newText)
}

export type ReverseFileResult =
  | {
      ok: true
      action: TurnUndoAction
      afterExists: boolean
      afterText: string | null
    }
  | {
      ok: false
      action: TurnUndoAction
      status: Exclude<TurnUndoFileStatus, 'ready'>
      reason: TurnUndoReason
    }

function inferAction(ops: readonly FileOp[]): TurnUndoAction {
  const first = ops[0]
  const last = ops.at(-1)
  if (first?.kind === 'create' && last?.kind !== 'delete') return 'delete'
  if (last?.kind === 'delete' && first?.kind !== 'create') return 'restore'
  return 'revert'
}

/** Reverses all operations for one file in reverse chronological order against its current disk state. */
export function reverseFileOps(
  disk: { exists: boolean; text: string | null },
  ops: readonly FileOp[],
): ReverseFileResult {
  const fallbackAction = inferAction(ops)
  let exists = disk.exists
  let text = disk.text

  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i]!
    switch (op.kind) {
      case 'unsupported':
        return { ok: false, action: fallbackAction, status: 'unsupported', reason: op.reason }
      case 'create': {
        if (!exists || text === null) {
          return { ok: false, action: 'delete', status: 'conflict', reason: 'file_missing' }
        }
        if (text !== op.newText) {
          return {
            ok: false,
            action: 'delete',
            status: 'conflict',
            reason: 'modified_after_turn',
          }
        }
        exists = false
        text = null
        break
      }
      case 'delete': {
        if (op.oldText === null) {
          return {
            ok: false,
            action: 'restore',
            status: 'unsupported',
            reason: 'missing_before_snapshot',
          }
        }
        if (exists) {
          return {
            ok: false,
            action: 'restore',
            status: 'conflict',
            reason: 'file_already_exists',
          }
        }
        exists = true
        text = op.oldText
        break
      }
      case 'edit': {
        if (op.oldText === op.newText) break
        if (!exists || text === null) {
          return { ok: false, action: fallbackAction, status: 'conflict', reason: 'file_missing' }
        }
        const reversed = reverseSingleEdit(text, op.oldText, op.newText)
        if (!reversed.ok) {
          return {
            ok: false,
            action: fallbackAction,
            status: 'conflict',
            reason: reversed.reason,
          }
        }
        text = reversed.text
        break
      }
    }
  }

  let action: TurnUndoAction
  if (disk.exists && !exists) action = 'delete'
  else if (!disk.exists && exists) action = 'restore'
  else action = 'revert'

  return { ok: true, action, afterExists: exists, afterText: text }
}

interface PlannedWrite {
  relative: string
  targetPath: string
  action: TurnUndoAction
  /** True when disk state already equals post-undo state (no-op). */
  noop: boolean
  originalExists: boolean
  originalBytes: Buffer | null
  originalMode: number | null
  originalNlink: number
  writeBytes: Buffer | null
}

interface InternalPlan {
  realRoot: string
  preview: TurnUndoPreview
  writes: PlannedWrite[]
}

function combinedFingerprint(digests: readonly TurnUndoFileDigest[]): string {
  const sorted = [...digests].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return sha256Hex(JSON.stringify(sorted))
}

async function buildPlan(options: {
  workRoot: string
  entries: readonly ToolEntry[]
  platform: Platform
  alreadyUndone: boolean
  maxBytes?: number
}): Promise<InternalPlan> {
  const { workRoot, entries, platform, alreadyUndone } = options
  const maxBytes = options.maxBytes ?? FILE_READ_LIMIT
  const realRoot = await realpath(workRoot)
  const collected = collectTurnFileOps(entries, workRoot, platform)

  const fileDigests: TurnUndoFileDigest[] = []
  const affectedFiles: TurnUndoFilePreview[] = []
  const conflicts: TurnUndoConflict[] = []
  const writes: PlannedWrite[] = []

  for (const item of collected) {
    if (!item.pathValid) {
      const reason = item.pathReason ?? 'outside_workspace'
      fileDigests.push({ path: item.path, exists: false, sha256: null, size: null })
      affectedFiles.push({
        path: item.path,
        displayPath: item.displayPath,
        action: inferAction(item.ops),
        status: 'unsupported',
        reason,
        beforeText: null,
        afterText: null,
        editCount: item.ops.length,
      })
      conflicts.push({ path: item.path, reason })
      continue
    }

    const checked = await resolveSafeTarget(realRoot, item.path, platform)
    if (!checked.ok) {
      fileDigests.push({ path: item.path, exists: false, sha256: null, size: null })
      affectedFiles.push({
        path: item.path,
        displayPath: item.displayPath,
        action: inferAction(item.ops),
        status: checked.reason === 'directory_in_way' ? 'conflict' : 'unsupported',
        reason: checked.reason,
        beforeText: null,
        afterText: null,
        editCount: item.ops.length,
      })
      conflicts.push({ path: item.path, reason: checked.reason })
      continue
    }

    const disk = await readDiskSnapshot(checked, maxBytes)
    fileDigests.push(disk.digest)

    if (disk.readError) {
      affectedFiles.push({
        path: item.path,
        displayPath: item.displayPath,
        action: inferAction(item.ops),
        status: 'unsupported',
        reason: disk.readError,
        beforeText: null,
        afterText: null,
        editCount: item.ops.length,
      })
      conflicts.push({ path: item.path, reason: disk.readError })
      continue
    }

    const reversed = reverseFileOps({ exists: disk.exists, text: disk.textLf }, item.ops)
    if (!reversed.ok) {
      affectedFiles.push({
        path: item.path,
        displayPath: item.displayPath,
        action: reversed.action,
        status: reversed.status,
        reason: reversed.reason,
        beforeText: disk.textLf,
        afterText: null,
        editCount: item.ops.length,
      })
      conflicts.push({ path: item.path, reason: reversed.reason })
      continue
    }

    const noop =
      disk.exists === reversed.afterExists && (!disk.exists || disk.textLf === reversed.afterText)
    const writeBytes =
      reversed.afterExists && reversed.afterText !== null
        ? Buffer.from(applyLineEnding(reversed.afterText, disk.eol), 'utf8')
        : null

    affectedFiles.push({
      path: item.path,
      displayPath: item.displayPath,
      action: reversed.action,
      status: 'ready',
      beforeText: disk.textLf,
      afterText: reversed.afterText,
      editCount: item.ops.length,
    })

    writes.push({
      relative: item.path,
      targetPath: checked.targetPath,
      action: reversed.action,
      noop,
      originalExists: disk.exists,
      originalBytes: disk.rawBytes,
      originalMode: disk.mode,
      originalNlink: disk.nlink,
      writeBytes,
    })
  }

  const fingerprint = combinedFingerprint(fileDigests)
  const canApply = !alreadyUndone && affectedFiles.length > 0 && conflicts.length === 0

  return {
    realRoot,
    preview: {
      fingerprint,
      fileDigests,
      affectedFiles,
      conflicts,
      canApply,
      alreadyUndone,
    },
    writes,
  }
}

/** Computes a read-only preview and current disk fingerprints for undoing one turn. */
export async function previewTurnUndo(options: {
  workRoot: string
  entries: readonly ToolEntry[]
  platform: Platform
  alreadyUndone?: boolean
  maxBytes?: number
}): Promise<TurnUndoPreview> {
  const plan = await buildPlan({
    workRoot: options.workRoot,
    entries: options.entries,
    platform: options.platform,
    alreadyUndone: options.alreadyUndone ?? false,
    ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
  })
  return plan.preview
}

/** Returns every path whose current digest differs from the preview's `expectedDigests`. */
export function diffFileDigests(
  expected: readonly TurnUndoFileDigest[],
  actual: readonly TurnUndoFileDigest[],
): string[] {
  const expectedMap = new Map(expected.map((d) => [d.path, d]))
  const actualMap = new Map(actual.map((d) => [d.path, d]))
  const allPaths = new Set([...expectedMap.keys(), ...actualMap.keys()])
  const changed: string[] = []
  for (const filePath of allPaths) {
    const a = expectedMap.get(filePath)
    const b = actualMap.get(filePath)
    if (!a || !b || a.exists !== b.exists || a.sha256 !== b.sha256 || a.size !== b.size) {
      changed.push(filePath)
    }
  }
  changed.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return changed
}

async function writeInPlace(targetPath: string, bytes: Buffer): Promise<void> {
  const handle = await open(targetPath, 'r+')
  try {
    await handle.truncate(0)
    await handle.write(bytes, 0, bytes.length, 0)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function replaceFileAtomic(
  targetPath: string,
  bytes: Buffer,
  mode: number,
  nlink: number,
  platform: Platform,
): Promise<void> {
  if (nlink > 1) {
    await writeInPlace(targetPath, bytes)
    return
  }
  const api = platform === 'win32' ? path.win32 : path.posix
  const temp = api.join(
    api.dirname(targetPath),
    `.${api.basename(targetPath)}.${randomBytes(4).toString('hex')}.kettu-undo-tmp`,
  )
  const fileMode = mode & 0o7777
  const handle = await open(temp, 'wx', fileMode || 0o666)
  try {
    await handle.writeFile(bytes)
    if (fileMode) await handle.chmod(fileMode)
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => {})
    await unlink(temp).catch(() => {})
    throw error
  }
  await handle.close()
  try {
    await rename(temp, targetPath)
  } catch (error) {
    await unlink(temp).catch(() => {})
    const code = (error as NodeJS.ErrnoException | undefined)?.code ?? ''
    if (platform !== 'win32' || !RENAME_REFUSED.has(code)) throw error
    await writeInPlace(targetPath, bytes)
  }
}

async function ensureSafeParentDirs(
  realRoot: string,
  relative: string,
  platform: Platform,
): Promise<{ parentDir: string; createdDirs: string[] }> {
  const api = platform === 'win32' ? path.win32 : path.posix
  const dirSegments = relative.split('/').slice(0, -1)
  let current = realRoot
  const createdDirs: string[] = []

  for (const segment of dirSegments) {
    const next = api.join(current, segment)
    let created = false
    try {
      await mkdir(next)
      created = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== 'EEXIST') throw error
    }
    const realNext = await realpath(next)
    if (!withinRoot(realRoot, realNext, platform)) {
      if (created) await rmdir(next).catch(() => {})
      throw new Error(`Target directory escapes workspace: ${relative}`)
    }
    if (!(await stat(realNext)).isDirectory()) {
      throw new Error(`Parent path is not a directory: ${relative}`)
    }
    if (created) createdDirs.push(realNext)
    current = realNext
  }

  return { parentDir: current, createdDirs }
}

async function createFileExclusive(
  targetPath: string,
  bytes: Buffer,
  mode?: number,
): Promise<void> {
  const fileMode = mode ? mode & 0o7777 : 0o666
  const handle = await open(targetPath, 'wx', fileMode)
  try {
    await handle.writeFile(bytes)
    if (mode && fileMode) await handle.chmod(fileMode)
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => {})
    await unlink(targetPath).catch(() => {})
    throw error
  }
  await handle.close()
}

interface RollbackRecord {
  plan: PlannedWrite
  createdDirs: string[]
  finalPath: string
}

async function rollbackApplied(
  records: readonly RollbackRecord[],
  platform: Platform,
): Promise<void> {
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i]!
    const { plan, finalPath, createdDirs } = record
    try {
      if (plan.action === 'revert' && plan.originalBytes !== null) {
        await replaceFileAtomic(
          finalPath,
          plan.originalBytes,
          plan.originalMode ?? 0o666,
          plan.originalNlink,
          platform,
        )
      } else if (plan.action === 'delete' && plan.originalBytes !== null) {
        await createFileExclusive(finalPath, plan.originalBytes, plan.originalMode ?? undefined)
      } else if (plan.action === 'restore') {
        await unlink(finalPath).catch(() => {})
        for (let d = createdDirs.length - 1; d >= 0; d--) {
          await rmdir(createdDirs[d]!).catch(() => {})
        }
      }
    } catch {
      // Best-effort rollback: keep restoring the remaining files even if one fails.
    }
  }
}

/**
 * Re-verifies every affected file against `expectedDigests` and conflict rules before writing a
 * single byte. Writes all changes cleanly (with rollback on unexpected mid-write I/O errors), or
 * returns `stale` / `conflict` with zero bytes written.
 */
export async function applyTurnUndo(options: {
  workRoot: string
  entries: readonly ToolEntry[]
  expectedDigests: readonly TurnUndoFileDigest[]
  platform: Platform
  alreadyUndone?: boolean
  maxBytes?: number
  /** Optional hook for testing mid-write rollback on unexpected I/O errors. */
  beforeWrite?: (relative: string, index: number) => void
}): Promise<TurnUndoResult> {
  const { workRoot, entries, expectedDigests, platform } = options
  const plan = await buildPlan({
    workRoot,
    entries,
    platform,
    alreadyUndone: options.alreadyUndone ?? false,
    ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
  })

  // 1. Check whether any file on disk changed since the preview was generated.
  const changedPaths = diffFileDigests(expectedDigests, plan.preview.fileDigests)
  if (changedPaths.length > 0) {
    return {
      status: 'stale',
      changedPaths,
      preview: plan.preview,
    }
  }

  // 2. Refuse to write anything if any file has a conflict, is unsupported, or already undone.
  if (!plan.preview.canApply || plan.preview.conflicts.length > 0) {
    return {
      status: 'conflict',
      preview: plan.preview,
    }
  }

  // 3. Apply every planned filesystem change with best-effort rollback on unexpected I/O failure.
  const api = platform === 'win32' ? path.win32 : path.posix
  const applied: RollbackRecord[] = []
  const revertedFiles: string[] = []
  const deletedFiles: string[] = []
  const restoredFiles: string[] = []

  try {
    for (let i = 0; i < plan.writes.length; i++) {
      const write = plan.writes[i]!
      if (write.noop) continue
      options.beforeWrite?.(write.relative, i)

      // Final TOCTOU safety guard before touching disk.
      const recheck = await resolveSafeTarget(plan.realRoot, write.relative, platform)
      if (!recheck.ok) {
        throw new Error(`Unsafe undo target (${recheck.reason}): ${write.relative}`)
      }

      if (write.action === 'delete') {
        await unlink(recheck.targetPath)
        applied.push({ plan: write, createdDirs: [], finalPath: recheck.targetPath })
        deletedFiles.push(write.relative)
      } else if (write.action === 'restore') {
        const { parentDir, createdDirs } = await ensureSafeParentDirs(
          plan.realRoot,
          write.relative,
          platform,
        )
        const finalPath = api.join(parentDir, api.basename(write.relative))
        await createFileExclusive(finalPath, write.writeBytes ?? Buffer.alloc(0))
        applied.push({ plan: write, createdDirs, finalPath })
        restoredFiles.push(write.relative)
      } else {
        await replaceFileAtomic(
          recheck.targetPath,
          write.writeBytes ?? Buffer.alloc(0),
          write.originalMode ?? 0o666,
          write.originalNlink,
          platform,
        )
        applied.push({ plan: write, createdDirs: [], finalPath: recheck.targetPath })
        revertedFiles.push(write.relative)
      }
    }
  } catch (error) {
    await rollbackApplied(applied, platform)
    throw error
  }

  return {
    status: 'applied',
    revertedFiles,
    deletedFiles,
    restoredFiles,
  }
}
