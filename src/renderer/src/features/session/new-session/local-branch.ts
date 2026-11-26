// Local branch picker model, running-session checks, and immediate branch switching for
// New session's WorktreeMenu when working in the project folder (`where === 'local'`).

import { branchProblem } from '@shared/branch-name'
import type { SessionSummary } from '@shared/agent-host'
import type { BranchInfo, BranchList, GitStatus } from '@shared/git'
import { failureNote } from '@renderer/features/git/results'
import { recentBranches } from '@renderer/features/git/switcher-model'
import { failureOf, type FailureKind } from '@renderer/features/git/sync'
import { i18n } from '@renderer/lib/i18n'
import { refreshGitProject, runGitOperation, useGitStore } from '@renderer/stores/git'
import { projectSummaries } from '@renderer/stores/sessions'
import { refreshPreparedForProject } from './prepared'

/** Sentinel ComboboxItem value for creating a new local branch; no valid git ref can match it. */
export const LOCAL_NEW_BRANCH = '\0local-new-branch'

export interface LocalBranchGroup {
  value: 'local' | 'new'
  items: string[]
}

export interface LocalBranchModel {
  current: string | null
  byName: Map<string, BranchInfo>
  groups: LocalBranchGroup[]
  createName: string | null
}

export interface LocalBranchSwitchFailure {
  ok: false
  branch: string
  create: boolean
  kind: FailureKind
  busy: boolean
  log: string
  message: string
  suggestWorktree: boolean
}

export type LocalBranchSwitchResult =
  { ok: true; status: GitStatus; branch: string; created: boolean } | LocalBranchSwitchFailure

/** Builds the local-branch picker groups, keeping the current branch first and offering creation. */
export function buildLocalBranchModel(
  list: BranchList,
  status: GitStatus,
  query: string,
): LocalBranchModel {
  const current = status.head.detached ? null : status.head.branch
  const byName = new Map(list.branches.map((branch) => [branch.name, branch]))
  const others = recentBranches(
    list.branches.map((branch) => branch.name),
    current,
    status.defaultBranch,
  )
  const local = current ? [current, ...others] : others
  const typed = query.trim()
  const createName =
    typed !== '' && !byName.has(typed) && branchProblem(typed) === null ? typed : null
  const groups: LocalBranchGroup[] = createName
    ? [
        { value: 'local', items: local },
        { value: 'new', items: [LOCAL_NEW_BRANCH] },
      ]
    : [{ value: 'local', items: local }]
  return { current, byName, groups, createName }
}

/**
 * Counts active sessions currently running in `projectPath` itself (excluding worktree and
 * prepared sessions). Subagents are deduplicated under their parent session when present.
 */
export function runningLocalSessionsCount(
  byId: Record<string, SessionSummary>,
  projectPath: string,
): number {
  const roots = new Set<string>()
  for (const session of projectSummaries(byId, projectPath)) {
    if (session.archivedAt || session.prepared || session.worktree || session.agentWorktree) {
      continue
    }
    if (session.status !== 'running' && session.status !== 'awaiting_permission') continue
    roots.add(session.origin === 'subagent' && session.parentId ? session.parentId : session.id)
  }
  return roots.size
}

/** Whether the working tree currently has staged, unstaged, untracked, or conflicted changes. */
export function hasUncommittedChanges(status: GitStatus | undefined): boolean {
  if (!status) return false
  const { staged, unstaged, untracked, conflicted } = status.changes
  return staged + unstaged + untracked + conflicted > 0
}

/** Formats a failed local branch switch using the shared git failure catalog. */
export function formatLocalSwitchFailure(
  branch: string,
  create: boolean,
  log: string,
  busy: boolean,
  status?: GitStatus,
): LocalBranchSwitchFailure {
  const note = failureNote({ kind: 'switch', branch, create }, log, busy)
  const values = note.operation
    ? { ...note.values, operation: i18n.t(`git:failure.operation.${note.operation}`) }
    : note.values
  const message = i18n.t(`git:${note.key}`, values)
  const kind: FailureKind = busy ? 'busy' : failureOf(log)
  const suggestWorktree = !busy && (kind === 'localChanges' || hasUncommittedChanges(status))
  return { ok: false, branch, create, kind, busy, log, message, suggestWorktree }
}

/**
 * Switches `projectPath` to `branch` (or creates it from HEAD), refreshes git metadata and any
 * prepared session targeting the same project, and returns structured success or failure details.
 */
export async function switchLocalBranch(
  projectPath: string,
  branch: string,
  create: boolean,
): Promise<LocalBranchSwitchResult> {
  const before = useGitStore.getState().status[projectPath]
  const result = await runGitOperation(projectPath, { kind: 'switch', branch, create })
  if (result) {
    refreshGitProject(projectPath)
    refreshPreparedForProject(projectPath)
    return {
      ok: true,
      status: result.status,
      branch: result.status.head.branch ?? branch,
      created: create,
    }
  }
  const failed = useGitStore.getState().failed[projectPath]
  return formatLocalSwitchFailure(branch, create, failed?.log ?? '', failed?.busy ?? false, before)
}
