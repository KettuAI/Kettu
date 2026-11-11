import { create } from 'zustand'
import type { SessionSummary } from '@shared/agent-host'
import type { WorktreeInspection } from '@shared/git'
import { toast } from '@renderer/components/ui/toast'
import { errorMessage, host } from '@renderer/lib/host'
import { hostOfPath } from '@renderer/lib/host-paths'
import { i18n } from '@renderer/lib/i18n'
import { allowsTerminal } from '@renderer/stores/hosts'
import { useSessionsStore } from '@renderer/stores/sessions'
import { killTerminal, loadTerminals, useTerminalsStore } from '@renderer/stores/terminals'

export type Inspected = WorktreeInspection & { others: string[] }

/** What led to the question: the session menu, or the session's archive or delete. */
export type RemovalReason = 'menu' | 'archived' | 'deleting'

export interface RemovalQuestion {
  id: number
  summary: SessionSummary
  reason: RemovalReason
  /** Read before asking, when the question is only asked for a worktree no one else uses. */
  inspected: Inspected | null
  done: () => void
}

export const useWorktreeRemoval = create<{ question: RemovalQuestion | null; busy: boolean }>(
  () => ({ question: null, busy: false }),
)

/** A worktree Kettu made that is still on disk, or should be: not yet removed by Kettu. */
export function hasLiveWorktree(summary: Pick<SessionSummary, 'worktree'>): boolean {
  const worktree = summary.worktree
  return (
    !!worktree && worktree.path !== '' && worktree.state !== 'removed' && worktree.state !== 'gone'
  )
}

/** Whether the session menu offers Remove worktree: not while it is being made or prepared. */
export function canRemoveWorktree(summary: Pick<SessionSummary, 'worktree'>): boolean {
  const state = summary.worktree?.state
  return (
    hasLiveWorktree(summary) &&
    (state === 'ready' || state === 'setup-failed' || state === 'missing')
  )
}

/**
 * What the question offers: `branch` removes the worktree and its merged branch, `worktree` only
 * the folder, and `atStake` the folder after a warning about what it loses. Unpushed commits count
 * as safe once the branch is merged, since its changes are in the base then.
 */
export function removalChoice(inspected: WorktreeInspection): 'branch' | 'worktree' | 'atStake' {
  const clean = inspected.uncommitted === 0 && (inspected.unpushed === 0 || inspected.merged)
  if (!clean) return 'atStake'
  return inspected.merged && inspected.branchExists ? 'branch' : 'worktree'
}

let nextId = 1
let queue: Promise<void> = Promise.resolve()

/** Shows the question for one session; resolves once it closes. Questions wait their turn. */
export function askRemoveWorktree(
  summary: SessionSummary,
  reason: RemovalReason = 'menu',
  inspected: Inspected | null = null,
): Promise<void> {
  const asked = queue.then(
    () =>
      new Promise<void>((resolve) => {
        useWorktreeRemoval.setState({
          question: { id: nextId++, summary, reason, inspected, done: resolve },
        })
      }),
  )
  queue = asked
  return asked
}

/** Closes the open question. */
export function closeRemoval(): void {
  const { question } = useWorktreeRemoval.getState()
  if (!question) return
  useWorktreeRemoval.setState({ question: null, busy: false })
  question.done()
}

/**
 * After sessions are archived, or before they are deleted: asks about each top-level session's
 * worktree that no other session still works in. Nothing is removed without the user's choice.
 */
export async function offerWorktreeRemoval(
  summaries: readonly SessionSummary[],
  reason: Exclude<RemovalReason, 'menu'>,
): Promise<void> {
  for (const summary of summaries) {
    if (summary.parentId !== null || summary.origin === 'subagent') continue
    if (!hasLiveWorktree(summary)) continue
    let inspected: Inspected
    try {
      inspected = await host('worktrees.inspect', { sessionId: summary.id })
    } catch (error) {
      toast(i18n.t('sidebar:worktree.inspectFailed', { error: errorMessage(error) }))
      continue
    }
    if (inspected.others.length > 0) continue
    if (!inspected.exists && !inspected.branchExists) continue
    await askRemoveWorktree(summary, reason, inspected)
  }
}

/**
 * Ends the terminals of the sessions in the worktree and those open in its folder, then removes
 * it with what the user was shown, and takes the host's new summary.
 */
export async function removeWorktree(
  summary: SessionSummary,
  branch: 'keep' | 'delete',
  inspected: Inspected,
): Promise<SessionSummary> {
  const path = summary.worktree?.path ?? ''
  const users = new Set([summary.id, ...inspected.others])
  const all = Object.values(useSessionsStore.getState().byId)
  // Sub-sessions share their parent's worktree, at any depth.
  for (let grew = true; grew;) {
    grew = false
    for (const s of all) {
      if (s.parentId !== null && users.has(s.parentId) && !users.has(s.id)) {
        users.add(s.id)
        grew = true
      }
    }
  }
  if (path !== '' && allowsTerminal(hostOfPath(path))) await loadTerminals(path)
  const ending = Object.values(useTerminalsStore.getState().byId).filter(
    (t) =>
      !t.stale &&
      t.exitCode === null &&
      (t.projectPath === path || (t.sessionId !== null && users.has(t.sessionId))),
  )
  await Promise.all(ending.map((t) => killTerminal(t.id)))
  const expected: WorktreeInspection = {
    exists: inspected.exists,
    branchExists: inspected.branchExists,
    head: inspected.head,
    uncommitted: inspected.uncommitted,
    unpushed: inspected.unpushed,
    merged: inspected.merged,
  }
  const next = await host('worktrees.remove', { sessionId: summary.id, branch, expected })
  useSessionsStore.getState().upsert(next)
  return next
}
