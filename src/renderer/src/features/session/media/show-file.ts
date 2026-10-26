import { parseFileRef } from '@renderer/features/files/file-refs'
import { openFile } from '@renderer/stores/files'

/** Shows a project file in the Files pane, any other in the file manager, by its media URL. */
export function showFileAction(path: string, projectPath: string | null, url: string) {
  const ref = projectPath ? parseFileRef(path, projectPath) : null
  return {
    inFiles: !!ref,
    show: (): Promise<void> => {
      if (ref && projectPath) {
        openFile(projectPath, ref.path)
        return Promise.resolve()
      }
      return window.overbench.media.reveal(url)
    },
  }
}
