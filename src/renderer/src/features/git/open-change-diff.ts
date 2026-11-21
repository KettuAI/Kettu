import type { ChangedFile, GitStatus } from '@shared/git'
import { openDiff } from '@renderer/stores/files'
import { projectRelative } from './sync'

/** Shows a file's change, in the working tree or in a commit, in the Files pane. */
export function openChangeDiff(status: GitStatus, file: ChangedFile, commit: string | null): void {
  const root = status.repo?.root ?? status.projectPath
  openDiff(status.projectPath, {
    path: file.path,
    oldPath: file.oldPath,
    ref: commit,
    projectFile:
      file.status === 'deleted' ? null : projectRelative(root, status.projectPath, file.path),
  })
}
