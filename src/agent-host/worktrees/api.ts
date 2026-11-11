// The worktree service's interface, as sessions and the host use it.

import type { ProjectWorktreeSettings, WorktreeInspection } from '@shared/git'
import type { WorktreeRecord } from '../storage'

/** What a new worktree is made from; every path canonical, every name unchecked. */
export interface WorktreeRequest {
  projectPath: string
  /** The host's chosen folder for worktrees, or null for the folder beside the project. */
  root: string | null
  /** The ref to cut from, as the user or the caller named it. */
  base: string
  /** A branch name the user wrote, used as it is once it passes the checks. */
  branch?: string
  template: string
  /** The first message's text, for `{slug}`. */
  text: string
  type?: string
  issue?: string
  /** Whether a pull request already uses the branch name, from what the git service knows. */
  takenByPullRequest?: (branch: string) => boolean
}

export interface SetupRun {
  exitCode: number | null // null when it was stopped or ran out of time
  timedOut: boolean
  /** The last lines of what it wrote, stdout and stderr together. */
  tail: string
}

export interface SetupOptions {
  cwd: string
  projectPath: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  signal?: AbortSignal
  onOutput?: (chunk: string) => void
}

export interface CopyResult {
  copied: string[]
  skipped: { path: string; reason: string }[]
}

export interface WorktreeGit {
  /** Where worktrees go for a project: `root`, or beside it, or `~/.kettu/worktrees`. */
  rootFor(projectPath: string, root: string | null): Promise<string>
  /** Creates the branch and the worktree; rejects with `invalid_params` on a bad name or base. */
  create(request: WorktreeRequest): Promise<WorktreeRecord>
  /** Copies the project's local files that `.worktreeinclude` and `extra` name. */
  copyLocalFiles(projectPath: string, worktreePath: string, extra: string[]): Promise<CopyResult>
  runSetup(command: string, options: SetupOptions): Promise<SetupRun>
  inspect(projectPath: string, record: WorktreeRecord): Promise<WorktreeInspection>
  /**
   * Removes the worktree, and its branch when asked and safe. Rejects with `conflict` when the
   * worktree no longer matches `expected`, and never forces a dirty worktree away.
   */
  remove(
    projectPath: string,
    record: WorktreeRecord,
    options: { branch: 'keep' | 'delete'; expected: WorktreeInspection },
  ): Promise<{ branchDeleted: boolean }>
  /** Puts the worktree back at its path from its branch, after pruning git's stale entry. */
  recreate(projectPath: string, record: WorktreeRecord): Promise<void>
  /** Drops git's entries for worktrees whose folders are gone. */
  prune(projectPath: string): Promise<void>
}

export type { ProjectWorktreeSettings, WorktreeInspection }
