import type { ChangedFile, GitStatus } from '@shared/git'
import { diffId, diffKey, openDiff, useFilesStore } from '@renderer/stores/files'
import type { OpenDocOptions } from '@renderer/stores/view'
import { projectRelative } from './sync'
import { peekFileDiff } from './use-git-data'

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
  // Prime a freshly created working-tree diff tab from an already-loaded inline preview so
  // switching to the full diff tab avoids a loading flash while the background refresh runs.
  if (commit === null) {
    const key = diffKey(status.projectPath, diffId({ path: file.path, ref: null }))
    const cached = peekFileDiff(status.projectPath, file)
    if (cached && useFilesStore.getState().diffs[key]?.result === null) {
      useFilesStore.setState((s) =>
        s.diffs[key]?.result === null
          ? { diffs: { ...s.diffs, [key]: { ...s.diffs[key], result: cached } } }
          : s,
      )
    }
  }
}
