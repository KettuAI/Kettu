// What the Files tree does to the project's files and folders through its host: new, rename,
// move, copy and delete, with the open tabs following and the list read again after.

import { toast } from '@renderer/components/ui/toast'
import { emitAppEvent } from '@renderer/app/events'
import { errorCode, errorMessage, host } from '@renderer/lib/host'
import { hostPath } from '@renderer/lib/host-paths'
import { i18n } from '@renderer/lib/i18n'
import {
  closeRemoved,
  followMoves,
  loadFiles,
  openFile,
  useFilesStore,
} from '@renderer/stores/files'
import { folderOf, joinPath, nameOf, outermost } from './paths'

/** What a failure says: a name already taken in the user's words, anything else as it came. */
function failed(error: unknown): void {
  toast(
    errorCode(error) === 'conflict'
      ? i18n.t('files:tree.taken')
      : i18n.t('files:tree.failed', { message: errorMessage(error) }),
  )
}

/** A new empty file, which opens in a tab, or folder. False when it could not be made. */
export async function createEntry(
  projectPath: string,
  path: string,
  kind: 'file' | 'folder',
): Promise<boolean> {
  try {
    await host('files.create', { projectPath, path, kind })
  } catch (error) {
    failed(error)
    return false
  }
  await loadFiles(projectPath)
  if (kind === 'file') openFile(projectPath, path, null, { fromPanel: true })
  return true
}

/** Renames or moves one file or folder; its open tabs follow. */
export async function renameEntry(projectPath: string, from: string, to: string): Promise<boolean> {
  if (from === to) return true
  try {
    await host('files.rename', { projectPath, from, to })
  } catch (error) {
    failed(error)
    return false
  }
  followMoves(projectPath, [{ from, to }])
  await loadFiles(projectPath)
  return true
}

/**
 * Moves files and folders into `folder`, keeping their names; what is there already stays, and
 * the first failure is told. The paths they moved to.
 */
export async function moveEntries(
  projectPath: string,
  paths: readonly string[],
  folder: string,
): Promise<string[]> {
  const moves: { from: string; to: string }[] = []
  let failure: unknown = null
  for (const from of outermost(paths)) {
    const to = joinPath(folder, nameOf(from))
    if (to === from) continue
    try {
      await host('files.rename', { projectPath, from, to })
      moves.push({ from, to })
    } catch (error) {
      failure ??= error
    }
  }
  if (failure !== null) failed(failure)
  followMoves(projectPath, moves)
  if (moves.length > 0 || failure !== null) await loadFiles(projectPath)
  return moves.map(({ to }) => to)
}

/** Copies files and folders into `folder`, a taken name getting a copy's name. The copies. */
export async function copyEntries(
  projectPath: string,
  paths: readonly string[],
  folder: string,
): Promise<string[]> {
  try {
    const copies = await host('files.copy', { projectPath, paths: outermost(paths), folder })
    await loadFiles(projectPath)
    return copies
  } catch (error) {
    failed(error)
    await loadFiles(projectPath)
    return []
  }
}

/** Keeps the paths for a paste in the same project; a cut moves them when pasted. */
export function putOnClipboard(projectPath: string, paths: readonly string[], cut: boolean): void {
  if (paths.length === 0) return
  useFilesStore.setState({ clipboard: { projectPath, paths: outermost(paths), cut } })
}

/** Whether something cut or copied in this project waits to be pasted. */
export const canPaste = (projectPath: string): boolean =>
  useFilesStore.getState().clipboard?.projectPath === projectPath

/** Pastes what was cut or copied into `folder`: a cut moves once, a copy copies each time. */
export async function pasteInto(projectPath: string, folder: string): Promise<string[]> {
  const clipboard = useFilesStore.getState().clipboard
  if (!clipboard || clipboard.projectPath !== projectPath) return []
  if (!clipboard.cut) return copyEntries(projectPath, clipboard.paths, folder)
  useFilesStore.setState({ clipboard: null })
  return moveEntries(projectPath, clipboard.paths, folder)
}

/**
 * Deletes files and folders, to the trash unless `permanently`, and closes their tabs.
 * `no-trash` when the host could put them in no trash, so the user may delete them for good.
 */
export async function deleteEntries(
  projectPath: string,
  paths: readonly string[],
  permanently: boolean,
): Promise<'done' | 'no-trash' | 'failed'> {
  const outer = outermost(paths)
  try {
    await host('files.delete', { projectPath, paths: outer, permanently })
  } catch (error) {
    await loadFiles(projectPath)
    if (!permanently && errorCode(error) === 'unavailable') return 'no-trash'
    failed(error)
    return 'failed'
  }
  closeRemoved(projectPath, outer)
  const clipboard = useFilesStore.getState().clipboard
  if (clipboard?.projectPath === projectPath && clipboard.paths.some((p) => outer.includes(p))) {
    useFilesStore.setState({ clipboard: null })
  }
  await loadFiles(projectPath)
  return 'done'
}

/** A path of the project as its host writes it, joined with the separator the host uses. */
export function hostFilePath(projectPath: string, path: string): string {
  const root = hostPath(projectPath)
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/'
  return path === '' ? root : `${root.replace(/[\\/]+$/, '')}${sep}${path.split('/').join(sep)}`
}

/** Copies the paths, one a line, telling once they are copied. */
export function copyPaths(projectPath: string, paths: readonly string[], relative: boolean): void {
  const text = paths.map((path) => (relative ? path : hostFilePath(projectPath, path))).join('\n')
  void navigator.clipboard.writeText(text).then(
    () => toast(i18n.t('files:tree.copiedPath', { count: paths.length })),
    (error: unknown) => toast(errorMessage(error)),
  )
}

/** Opens a terminal in the side panel `panel`, starting in `folder` of the project. */
export function openTerminalIn(panel: string, folder: string): void {
  emitAppEvent({ kind: 'open-terminal', panel, folder })
}

/** The folder a new file or a paste goes into for a row: a folder itself, a file's folder. */
export const folderFor = (path: string | null, isFolder: boolean): string =>
  path === null ? '' : isFolder ? path : folderOf(path)
