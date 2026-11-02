import { useMemo } from 'react'
import type { ChangedFile, ChangeStatus } from '@shared/git'
import { projectRelative } from '@renderer/features/git/sync'
import { useChanges } from '@renderer/features/git/use-git-data'
import { useGitStore } from '@renderer/stores/git'

/** A changed file with the path the Files pane gives it, relative to the project. */
export interface ProjectChange {
  path: string
  file: ChangedFile
}

/** The changed files inside the project, deleted ones too, by the Files pane's paths. */
export function projectChanges(
  root: string,
  projectPath: string,
  files: readonly ChangedFile[],
): ProjectChange[] {
  const changes: ProjectChange[] = []
  for (const file of files) {
    const path = projectRelative(root, projectPath, file.path)
    if (path !== null) changes.push({ path, file })
  }
  return changes
}

/** Changed files by the paths the Files pane gives them, leaving out those it cannot list. */
export function changesByPath(
  root: string,
  projectPath: string,
  files: readonly ChangedFile[],
): ReadonlyMap<string, ChangeStatus> {
  const changes = new Map<string, ChangeStatus>()
  for (const { path, file } of projectChanges(root, projectPath, files)) {
    if (file.status !== 'deleted') changes.set(path, file.status)
  }
  return changes
}

const NONE: ReadonlyMap<string, ChangeStatus> = new Map()
const EMPTY: ProjectChange[] = []

export interface FileChanges {
  /** Every change inside the project, as git lists them; null until they load. */
  list: ProjectChange[] | null
  /** The listed files' changes by path. */
  byPath: ReadonlyMap<string, ChangeStatus>
  error: string | null
}

/** The project's uncommitted changes, kept current while the Files pane shows. */
export function useFileChanges(projectPath: string): FileChanges {
  const root = useGitStore((s) => s.status[projectPath]?.repo?.root ?? null)
  const { data, error } = useChanges(projectPath, root !== null)
  return useMemo(() => {
    if (!root) return { list: EMPTY, byPath: NONE, error: null }
    if (!data) return { list: null, byPath: NONE, error }
    return {
      list: projectChanges(root, projectPath, data),
      byPath: changesByPath(root, projectPath, data),
      error,
    }
  }, [root, projectPath, data, error])
}
