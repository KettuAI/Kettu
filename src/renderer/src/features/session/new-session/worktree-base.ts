import type { GitStatus } from '@shared/git'
import { useGitStore } from '@renderer/stores/git'

/** What the host's own check refuses in a branch name, told before the send. */
export function branchNameInvalid(name: string | null): boolean {
  if (!name) return false
  // eslint-disable-next-line no-control-regex
  return name.startsWith('-') || /[\s\x00-\x1f\x7f~^:?*[\\]/.test(name)
}

/** The project's status when it can have a worktree: a repository with at least one commit. */
export function useWorktreeStatus(projectPath: string): GitStatus | null {
  return useGitStore((s) => {
    const status = s.status[projectPath]
    return status?.repo && status.head.oid ? status : null
  })
}

/** Where a new worktree is cut from when the user picked none: the branch, or a detached commit. */
export function currentBase(status: GitStatus): string | null {
  return status.head.branch ?? status.head.oid
}
