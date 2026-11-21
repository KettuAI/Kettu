// Which changed files the next commit takes. A file is ticked unless the user left it out, so a
// file an agent writes meanwhile joins the commit; a conflicted file never can.

import type { ChangedFile } from '@shared/git'

/** The files a commit can take: everything changed but a conflicted file. */
export function committable(files: readonly ChangedFile[]): ChangedFile[] {
  return files.filter((file) => file.status !== 'conflicted')
}

/** The files the next commit takes. */
export function tickedFiles(
  files: readonly ChangedFile[],
  leftOut: readonly string[],
): ChangedFile[] {
  const out = new Set(leftOut)
  return committable(files).filter((file) => !out.has(file.path))
}

/**
 * The paths to leave out so that only `only` is ticked; with none given, every file is ticked.
 * Conflicted files are not listed, since they cannot be ticked anyway.
 */
export function leftOutExcept(
  files: readonly ChangedFile[],
  only: readonly string[] | null,
): string[] {
  if (only === null) return []
  const keep = new Set(only)
  return committable(files)
    .filter((file) => !keep.has(file.path))
    .map((file) => file.path)
}

export type TickState = 'all' | 'some' | 'none'

/** How the check box above the list reads: all of the files ticked, some or none. */
export function tickState(files: readonly ChangedFile[], leftOut: readonly string[]): TickState {
  const all = committable(files).length
  const ticked = tickedFiles(files, leftOut).length
  return ticked === 0 ? 'none' : ticked === all ? 'all' : 'some'
}

/** `leftOut` with `path` ticked or left out. */
export function toggled(leftOut: readonly string[], path: string, ticked: boolean): string[] {
  const rest = leftOut.filter((other) => other !== path)
  return ticked ? rest : [...rest, path]
}

/** `leftOut` after the ticked files were committed: only paths that are still changed stay in. */
export function afterCommit(
  files: readonly ChangedFile[],
  leftOut: readonly string[],
  committed: readonly string[],
): string[] {
  const done = new Set(committed)
  const remaining = new Set(files.filter((file) => !done.has(file.path)).map((file) => file.path))
  return leftOut.filter((path) => remaining.has(path))
}
