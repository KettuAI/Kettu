import { parseFileRef } from '@renderer/features/files/file-refs'
import { hostOfPath } from '@renderer/lib/host-paths'
import { isWeb } from '@renderer/lib/platform'
import { openFile } from '@renderer/stores/files'

/**
 * Shows a project file in the Files pane, any other in the file manager, by its media URL; null
 * for a file outside the project in the web client, which has no file manager of the host's.
 */
export function showFileAction(path: string, projectPath: string | null, url: string) {
  const ref = projectPath ? parseFileRef(path, projectPath) : null
  // Neither a browser nor this computer has a file manager of another host's.
  if (!ref && (isWeb || (projectPath !== null && hostOfPath(projectPath) !== null))) return null
  return {
    inFiles: !!ref,
    show: (): Promise<void> => {
      if (ref && projectPath) {
        openFile(projectPath, ref.path)
        return Promise.resolve()
      }
      return window.kettu.media.reveal(url)
    },
  }
}

/**
 * Shows any file in the file manager where this computer has the host's; elsewhere, a project file
 * in the Files pane as `showFileAction` does, and null for any other.
 */
export function revealFileAction(path: string, projectPath: string | null, url: string) {
  if (isWeb || (projectPath !== null && hostOfPath(projectPath) !== null)) {
    return showFileAction(path, projectPath, url)
  }
  return { inFiles: false, show: (): Promise<void> => window.kettu.media.reveal(url) }
}

/** Whether a path a reply names is inside the session's project. */
export function insideProject(path: string, projectPath: string | null): boolean {
  return projectPath !== null && !/^~[\\/]/.test(path) && parseFileRef(path, projectPath) !== null
}
