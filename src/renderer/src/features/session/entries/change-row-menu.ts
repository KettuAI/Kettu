// Pure availability and path rules for a changed file row's context menu.

import { relativeToRoot, resolveFilePath } from '@renderer/features/files/file-location'

export interface ChangeRowMenuInput {
  projectPath: string
  path: string
  /** Whether the project lives on this computer and runs in the desktop app. */
  local: boolean
  /** Whether the file is known to be deleted. */
  deleted: boolean
}

export interface ChangeRowMenuModel {
  /** Absolute local path to open in an editor or reveal in the file manager, else null. */
  localTarget: string | null
  /** Project-relative path to open in Kettu's Files pane, else null. */
  filesTarget: string | null
  /** Path string copied by "Copy path". */
  copyPath: string
  /** Path string copied by "Copy relative path", or null when outside the project. */
  copyRelativePath: string | null
}

/** Determines which actions a changed file row's context menu offers and their target paths. */
export function changeRowMenuModel({
  projectPath,
  path,
  local,
  deleted,
}: ChangeRowMenuInput): ChangeRowMenuModel {
  const resolved = resolveFilePath(projectPath, path)
  return {
    localTarget: local && !deleted ? resolved.absolutePath : null,
    filesTarget: !deleted ? resolved.relativePath : null,
    copyPath: resolved.absolutePath ?? path,
    copyRelativePath: resolved.relativePath,
  }
}

/** Whether a turn's changed file is deleted according to the turn itself or git working tree status. */
export function isChangeDeleted({
  changeDeleted,
  path,
  projectPath,
  repoRoot,
  gitDeleted,
}: {
  changeDeleted: boolean
  path: string
  projectPath: string
  repoRoot: string | null
  gitDeleted: ReadonlySet<string>
}): boolean {
  if (changeDeleted) return true
  if (repoRoot === null || gitDeleted.size === 0) return false
  const resolved = resolveFilePath(projectPath, path)
  const tracked = relativeToRoot(resolved.absolutePath ?? path, repoRoot)
  return tracked !== null && gitDeleted.has(tracked)
}
