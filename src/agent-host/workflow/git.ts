// The git a task needs beyond worktrees: whether a folder is a repository, its commit, what is not
// committed, and merging a parallel branch into the folder where its steps join.

import {
  commandFailureText,
  failureText,
  GIT_TIMEOUT_MS,
  type Exec,
  type ExecResult,
} from '../git/exec'

const MERGE_TIMEOUT_MS = 120_000
const MAX_LISTED = 50

export interface MergeResult {
  merged: boolean
  /** The files in conflict, left for the step's agent to resolve. */
  conflicts: string[]
  /** Why git could not merge at all; null when it merged or stopped on conflicts. */
  error: string | null
}

export interface TaskGit {
  /** The folder is inside a Git work tree. */
  isRepo(cwd: string): Promise<boolean>
  /** The commit checked out, or null when there is none. */
  head(cwd: string): Promise<string | null>
  /** Changed, staged and untracked paths, at most 50. */
  uncommitted(cwd: string): Promise<string[]>
  /** A merge stopped on conflicts waits to be committed. */
  merging(cwd: string): Promise<boolean>
  /** The paths in conflict now. */
  conflicts(cwd: string): Promise<string[]>
  /** Merges `branch` into what `cwd` has checked out, as its own commit. */
  merge(cwd: string, branch: string, message: string): Promise<MergeResult>
  /** Whether `branch` is already part of what `cwd` has checked out. */
  contains(cwd: string, branch: string): Promise<boolean>
}

function ok(result: ExecResult): boolean {
  return result.failure === null && result.code === 0
}

export function createTaskGit(exec: Exec): TaskGit {
  const git = (cwd: string, args: string[], timeoutMs = GIT_TIMEOUT_MS) =>
    exec('git', args, { cwd, timeoutMs })

  const conflicts = async (cwd: string): Promise<string[]> => {
    const result = await git(cwd, ['diff', '--name-only', '--diff-filter=U', '-z'])
    if (!ok(result)) return []
    return result.stdout.split('\0').filter(Boolean).slice(0, MAX_LISTED)
  }

  return {
    async isRepo(cwd) {
      const result = await git(cwd, ['rev-parse', '--is-inside-work-tree'])
      return ok(result) && result.stdout.trim() === 'true'
    },
    async head(cwd) {
      const result = await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'])
      return ok(result) ? result.stdout.trim() || null : null
    },
    async uncommitted(cwd) {
      const result = await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
      if (!ok(result)) throw new Error(commandFailureText('git status', result))
      return result.stdout
        .split('\0')
        .filter((item) => item.length > 3)
        .map((item) => item.slice(3))
        .slice(0, MAX_LISTED)
    },
    async merging(cwd) {
      const result = await git(cwd, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])
      return ok(result)
    },
    conflicts,
    async merge(cwd, branch, message) {
      // Only branches Kettu named reach here, and none of them starts with a dash.
      const result = await git(
        cwd,
        ['merge', '--no-ff', '--no-edit', '-m', message, branch],
        MERGE_TIMEOUT_MS,
      )
      if (ok(result)) return { merged: true, conflicts: [], error: null }
      const found = await conflicts(cwd)
      if (found.length > 0) return { merged: false, conflicts: found, error: null }
      return { merged: false, conflicts: [], error: failureText(result) }
    },
    async contains(cwd, branch) {
      const result = await git(cwd, ['merge-base', '--is-ancestor', branch, 'HEAD'])
      return ok(result)
    },
  }
}
