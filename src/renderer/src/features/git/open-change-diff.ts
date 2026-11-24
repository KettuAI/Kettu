import type { ChangedFile, GitStatus } from '@shared/git'
import { openDiff } from '@renderer/stores/files'
import type { OpenDocOptions } from '@renderer/stores/view'
import { projectRelative } from './sync'

/** Shows a file's change, in the working tree or in a commit, in a diff tab. */
export function openChangeDiff(
  status: GitStatus,
  file: ChangedFile,
  commit: string | null,
  options: OpenDocOptions = { preview: true },
): void {
  const root = status.repo?.root ?? status.projectPath
  openDiff(
    status.projectPath,
    {
      path: file.path,
      oldPath: file.oldPath,
      ref: commit,
      projectFile:
        file.status === 'deleted' ? null : projectRelative(root, status.projectPath, file.path),
    },
    options,
  )
}
