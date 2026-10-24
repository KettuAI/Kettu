// The composer's `@` mentions: the word being typed, the project's files and folders that match
// it, the files the session's tool calls used, and the text once one is chosen. Paths are relative
// to the project, with `/`.

import type { ThreadState } from '@shared/thread'
import { toolStep } from '@renderer/features/session/entries/helpers'
import { bestPaths } from '@renderer/features/files/paths'
import { relativePath } from '@renderer/lib/format'

/** Rows the popover shows at most. */
export const MENTION_LIMIT = 50

export interface Mention {
  /** Where the `@` is. */
  start: number
  /** What follows the `@` up to the caret, which choosing a row replaces with the `@`. */
  query: string
}

export interface MentionRow {
  path: string
  folder: boolean
  /** Indexes into `path` of the matched characters; a folder's path is read with a `/` after it. */
  positions: number[]
}

// A full-width at sign is what some input methods type for `@`.
const AT_SIGNS = '@\uFF20'

/** The mention at the caret, when its word starts with `@`; null otherwise. */
export function mentionAt(text: string, caret: number | null): Mention | null {
  if (caret === null || caret > text.length) return null
  let start = caret
  while (start > 0 && !/\s/.test(text[start - 1]!)) start--
  if (start === caret || !AT_SIGNS.includes(text[start]!)) return null
  return { start, query: text.slice(start + 1, caret) }
}

const folderCache = new WeakMap<readonly string[], string[]>()

/** Every folder that holds one of the files, with `/` after its path, once per list of files. */
export function foldersOf(files: readonly string[]): string[] {
  let folders = folderCache.get(files)
  if (folders) return folders
  const seen = new Set<string>()
  for (const file of files) {
    let slash = file.lastIndexOf('/')
    while (slash > 0) {
      const folder = file.slice(0, slash + 1)
      // Its own folders were seen with it.
      if (seen.has(folder)) break
      seen.add(folder)
      slash = file.lastIndexOf('/', slash - 1)
    }
  }
  folders = [...seen]
  folderCache.set(files, folders)
  return folders
}

/** The files and folders that match the query with the Files pane's matcher, best first. */
export function matchMentions(
  query: string,
  files: readonly string[],
  folders: readonly string[],
  limit = MENTION_LIMIT,
): MentionRow[] {
  const found = bestPaths(query, files, limit).map((match) => ({ ...match, folder: false }))
  const inFolders = bestPaths(query, folders, limit).map((match) => ({ ...match, folder: true }))
  return [...found, ...inFolders]
    .sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1))
    .slice(0, limit)
    .map(({ path, folder, positions }) => ({
      path: folder ? path.slice(0, -1) : path,
      folder,
      positions,
    }))
}

/**
 * The project's files this session's tool calls read or edited, most recent first, as far as the
 * thread is loaded.
 */
export function usedFiles(
  thread: ThreadState | null | undefined,
  projectPath: string,
  known: ReadonlySet<string>,
  limit = MENTION_LIMIT,
): string[] {
  if (!thread) return []
  const used: string[] = []
  const seen = new Set<string>()
  for (let i = thread.order.length - 1; i >= 0 && used.length < limit; i--) {
    const entry = thread.byId[thread.order[i]!]
    if (entry?.kind !== 'tool' || (entry.toolKind !== 'read' && entry.toolKind !== 'edit')) continue
    const step = toolStep(entry)
    if (step.kind !== 'tool') continue
    for (const path of step.paths) {
      const inside = relativePath(path, projectPath).replace(/\\/g, '/')
      if (seen.has(inside) || !known.has(inside)) continue
      seen.add(inside)
      used.push(inside)
      if (used.length >= limit) break
    }
  }
  return used
}

/** The name a chosen row is written as: a file's name, or a folder's with `/` after it. */
export function mentionName(row: Pick<MentionRow, 'path' | 'folder'>): string {
  const name = row.path.slice(row.path.lastIndexOf('/') + 1)
  return row.folder ? `${name}/` : name
}

/**
 * The text with the mention replaced by `@name `, and where the caret goes after it. Only what was
 * typed up to the caret is replaced, so nothing after it is lost.
 */
export function replaceMention(
  text: string,
  mention: Mention,
  name: string,
): { text: string; caret: number } {
  const before = `${text.slice(0, mention.start)}@${name}`
  const after = text.slice(mention.start + 1 + mention.query.length)
  // A space already there is the one after the name.
  const next = after.startsWith(' ') ? `${before}${after}` : `${before} ${after}`
  return { text: next, caret: before.length + 1 }
}

/** The text with `@` put at the caret, at the start of a word, and the caret after it. */
export function insertAt(text: string, from: number, to: number): { text: string; caret: number } {
  const before = text.slice(0, from)
  const sign = before === '' || /\s$/.test(before) ? '@' : ' @'
  return { text: `${before}${sign}${text.slice(to)}`, caret: from + sign.length }
}

/** What a key in the composer does while its popovers may be open. */
export type PopoverKey =
  /** Nothing: an input method is composing, so no key reaches a popover or the composer. */
  | 'block'
  /** The open popover handles it: moves, chooses with Enter, or closes with Esc. */
  | 'popover'
  /** Tab chooses the highlighted mention. */
  | 'choose'
  /** The composer handles it as usual. */
  | 'composer'

export function popoverKey(
  key: string,
  state: {
    composing: boolean
    /** Shift, Ctrl, Alt or Cmd is held; Base UI leaves such keys to the composer. */
    modified: boolean
    slashOpen: boolean
    mentionOpen: boolean
    /** The mention popover has rows to choose from. */
    mentionRows: boolean
  },
): PopoverKey {
  if (state.composing) return 'block'
  if (state.modified) return 'composer'
  if (state.slashOpen && (key === 'Enter' || key === 'Tab' || key === 'Escape')) return 'popover'
  if (!state.mentionOpen) return 'composer'
  if (key === 'Escape') return 'popover'
  // With no row to choose, Enter sends as usual.
  if (key === 'Enter') return state.mentionRows ? 'popover' : 'composer'
  if (key === 'Tab' && state.mentionRows) return 'choose'
  return 'composer'
}

/**
 * Whether the mention popover shows: not after Esc closed it for this `@`, and not for an `@` an
 * input method is still composing; one that was open stays open while a composition goes on.
 */
export function mentionShown(
  mention: Mention | null,
  dismissed: number | null,
  composition: { open: boolean } | null,
): boolean {
  return mention !== null && mention.start !== dismissed && (composition?.open ?? true)
}

/**
 * A name cut into runs of matched and unmatched characters, so each run is marked once. `offset`
 * is where the name starts in the path the positions index, in UTF-16 units as they are.
 */
export function markedRuns(
  name: string,
  offset: number,
  positions: readonly number[],
): { text: string; marked: boolean }[] {
  const marked = new Set(positions)
  const runs: { text: string; marked: boolean }[] = []
  let start = 0
  for (let i = 1; i <= name.length; i++) {
    if (i < name.length && marked.has(offset + i) === marked.has(offset + start)) continue
    runs.push({ text: name.slice(start, i), marked: marked.has(offset + start) })
    start = i
  }
  return runs
}
