// Pure click and context menu availability rules for file references in replies.

import { isAbsolutePath, isLocalProject } from './file-location'

export interface FileLinkActionInput {
  projectPath: string
  /** Absolute path as the project's host writes it (without any line suffix). */
  hostFile: string
  /** Whether the app is running in the web client rather than the desktop app. */
  web: boolean
}

export interface FileLinkActions {
  /** Local absolute path that may be opened in its default app or revealed in the file manager, else null. */
  localFile: string | null
}

export type FileLinkClickTarget = 'files-pane' | 'default-app'

/** Determines whether a file reference exposes local desktop actions (default app, file manager). */
export function fileLinkActions({
  projectPath,
  hostFile,
  web,
}: FileLinkActionInput): FileLinkActions {
  const canOpenLocally = isLocalProject(projectPath, web) && isAbsolutePath(hostFile)
  return { localFile: canOpenLocally ? hostFile : null }
}

/**
 * Decides where a left click on a file reference goes: plain clicks open Kettu's Files pane,
 * Mod-clicks (Cmd on macOS, Ctrl on Windows/Linux) open the local file in its system default app,
 * and remote or web sessions always fall back to the Files pane.
 */
export function fileLinkClickTarget({
  localFile,
  mod,
}: {
  localFile: string | null
  mod: boolean
}): FileLinkClickTarget {
  return localFile !== null && mod ? 'default-app' : 'files-pane'
}
