// Typing a path on the host, as the web client's folder and program pickers do in place of a
// system dialog: what `paths.complete` found for the typed text, as entries to go on with, Tab's
// completion, and the path the text names once it is one the picker takes.

import type { Platform } from '@shared/platform'
import type { PathCompletion } from '@shared/remote/host-admin'

/** A folder, as for a project or an agent's configuration, or a program the host can run. */
export type HostPathKind = 'folder' | 'program'

export interface PathEntry {
  name: string
  kind: 'folder' | 'file'
  /** What choosing the entry puts in the field: its full path, a folder's with a separator. */
  path: string
}

/** The most entries a list shows; typing more of the name narrows a larger folder. */
export const MAX_ENTRIES = 100

export function separator(platform: Platform): '/' | '\\' {
  return platform === 'win32' ? '\\' : '/'
}

function isSeparator(char: string, platform: Platform): boolean {
  return char === '/' || (platform === 'win32' && char === '\\')
}

/** Whether the host completes the text: an absolute path, or one from the home folder's `~`. */
export function isCompletable(typed: string, platform: Platform): boolean {
  if (typed.startsWith('~')) return true
  if (platform !== 'win32') return typed.startsWith('/')
  return /^[A-Za-z]:[\\/]/.test(typed) || typed.startsWith('\\\\')
}

/**
 * The text from the last root typed after a separator, as a file dialog's field starts over at a
 * `/` or `~` typed after a path; the field starts at home, so an absolute path typed there means
 * that path. On Windows a doubled separator stays, as a network path starts with one.
 */
export function restarted(typed: string, platform: Platform): string {
  for (let i = typed.length - 1; i > 0; i--) {
    if (!isSeparator(typed[i - 1]!, platform)) continue
    const rest = typed.slice(i)
    const home = /^~([\\/]|$)/.test(rest)
    const root = platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(rest) : rest.startsWith('/')
    if (home || root) return rest
  }
  return typed
}

/** Where a picker starts: the home folder, unless it knows a better one. */
export function homeStart(platform: Platform): string {
  return `~${separator(platform)}`
}

/** The folder a path is in, with a separator, for a picker to start beside it. */
export function folderOf(path: string, platform: Platform): string {
  for (let i = path.length - 1; i >= 0; i--) {
    if (isSeparator(path[i]!, platform)) return path.slice(0, i + 1)
  }
  return homeStart(platform)
}

/** The typed path's last part, after its last separator, which the host matches names with. */
export function lastPart(typed: string, platform: Platform): string {
  for (let i = typed.length - 1; i >= 0; i--) {
    if (isSeparator(typed[i]!, platform)) return typed.slice(i + 1)
  }
  return typed
}

/** `name` in `folder`, which ends with a separator only at a root such as `/` or `C:\`. */
export function joinPath(folder: string, name: string, platform: Platform): string {
  const end = folder.at(-1)
  const sep = end !== undefined && isSeparator(end, platform) ? '' : separator(platform)
  return `${folder}${sep}${name}`
}

/**
 * The entries to show for what was typed: folders to go into, and for a program the files the
 * host may run, folders first. Names starting with a dot show once the typed part does.
 */
export function pathEntries(
  typed: string,
  completion: PathCompletion,
  kind: HostPathKind,
  platform: Platform,
): PathEntry[] {
  const dotted = lastPart(typed, platform).startsWith('.')
  return completion.entries
    .filter((entry) => dotted || !entry.name.startsWith('.'))
    .filter((entry) => entry.kind === 'folder' || (kind === 'program' && entry.executable))
    .sort((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'folder' ? -1 : 1,
    )
    .slice(0, MAX_ENTRIES)
    .map((entry) => {
      const path = joinPath(completion.folder, entry.name, platform)
      return {
        name: entry.name,
        kind: entry.kind,
        path: entry.kind === 'folder' ? `${path}${separator(platform)}` : path,
      }
    })
}

/** The absolute path the typed text names, from the folder the host resolved its last part in. */
export function chosenPath(typed: string, completion: PathCompletion, platform: Platform): string {
  const last = lastPart(typed, platform)
  return last === '' ? completion.folder : joinPath(completion.folder, last, platform)
}

/** Whether the typed path is one the picker takes: a folder, or a file the host may run. */
export function canChoose(kind: HostPathKind, exact: PathCompletion['exact']): boolean {
  if (!exact) return false
  return kind === 'folder' ? exact.kind === 'folder' : exact.kind === 'file' && exact.executable
}

/**
 * What Tab makes of the text: the one entry listed, or the start every listed name shares where
 * it goes past what was typed; null when it adds nothing, so Tab moves on as usual.
 */
export function tabComplete(
  typed: string,
  entries: readonly PathEntry[],
  completion: PathCompletion,
  platform: Platform,
): string | null {
  if (entries.length === 0) return null
  if (entries.length === 1) return entries[0]!.path === typed ? null : entries[0]!.path
  const names = entries.map((entry) => entry.name)
  let shared = names[0]!
  for (const name of names.slice(1)) {
    let i = 0
    while (i < shared.length && i < name.length && shared[i] === name[i]) i++
    shared = shared.slice(0, i)
  }
  if (shared.length <= lastPart(typed, platform).length) return null
  return joinPath(completion.folder, shared, platform)
}
