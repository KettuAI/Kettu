import { useMemo } from 'react'
import type { ChangedFile, ChangeStatus } from '@shared/git'
import { projectRelative } from '@renderer/features/git/sync'
import { useChanges } from '@renderer/features/git/use-git-data'
import { useGitStore } from '@renderer/stores/git'

/** Changed files by the paths the Files pane gives them, leaving out those it cannot list. */
export function changesByPath(
  root: string,
  projectPath: string,
  files: readonly ChangedFile[],
): ReadonlyMap<string, ChangeStatus> {
  const changes = new Map<string, ChangeStatus>()
  for (const file of files) {
    if (file.status === 'deleted') continue
    const path = projectRelative(root, projectPath, file.path)
    if (path !== null) changes.set(path, file.status)
  }
  return changes
}

const NONE: ReadonlyMap<string, ChangeStatus> = new Map()

/** The project's uncommitted changes, kept current while the Files pane shows. */
export function useFileChanges(projectPath: string): ReadonlyMap<string, ChangeStatus> {
  const root = useGitStore((s) => s.status[projectPath]?.repo?.root ?? null)
  const { data } = useChanges(projectPath, root !== null)
  return useMemo(
    () => (root && data ? changesByPath(root, projectPath, data) : NONE),
    [root, projectPath, data],
  )
}
