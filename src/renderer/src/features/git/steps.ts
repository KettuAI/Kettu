// Runs the branch popover's and the Files pane's git writes and tells how each went in a toast,
// with the next step as its action.

import type { GitOperation, GitStatus } from '@shared/git'
import { toast } from '@renderer/components/ui/toast'
import { i18n } from '@renderer/lib/i18n'
import {
  openGitDialog,
  runGitOperation,
  useGitStore,
  type GitOperationRequest,
} from '@renderer/stores/git'
import { failureNote, successNote, type NextStep, type ResultNote } from './results'
import { pushTargetOf } from './sync'

const LABEL = {
  pull: 'git:sync.pull',
  push: 'git:sync.push',
  createPr: 'git:result.createPr',
  openPr: 'git:result.openPr',
  pullAndRetry: 'git:result.pullAndRetry',
  showLog: 'git:failure.showLog',
} as const satisfies Record<NextStep, string>

/**
 * Runs a write and toasts its result; the result, or null when it failed. A dialog that shows
 * its own failure passes `quietFailure`.
 */
export async function runStep(
  projectPath: string,
  request: GitOperationRequest,
  { quietFailure = false }: { quietFailure?: boolean } = {},
): Promise<GitOperation | null> {
  const before = useGitStore.getState().status[projectPath]
  const result = await runGitOperation(projectPath, request)
  if (!before) return result
  if (result) {
    const hasPr = !!useGitStore.getState().currentPr[projectPath]
    show(projectPath, successNote(request, before, result.status, hasPr))
  } else if (!quietFailure) {
    const failed = useGitStore.getState().failed[projectPath]
    if (failed) show(projectPath, failureNote(request, failed.log, failed.busy))
  }
  return result
}

/** Push, or publish to where push goes when the branch has no upstream yet. */
export function pushRequest(status: GitStatus): GitOperationRequest | null {
  const target = pushTargetOf(status)
  if (!target) return null
  return target.setUpstream
    ? { kind: 'publishBranch', remote: target.remote }
    : { kind: 'push', remote: target.remote, branch: target.branch }
}

/** Pushes the branch as Push would, asking first where it has to: the publish dialog. */
export function pushNow(projectPath: string): void {
  const status = useGitStore.getState().status[projectPath]
  if (!status) return
  if (status.push?.kind === 'noRemote') {
    openGitDialog(projectPath, { kind: 'publishRepo' })
    return
  }
  const target = pushTargetOf(status)
  if (target?.setUpstream) {
    openGitDialog(projectPath, { kind: 'publishBranch' })
    return
  }
  const request = pushRequest(status)
  if (request) void runStep(projectPath, request)
}

function show(projectPath: string, result: ResultNote): void {
  const values = result.operation
    ? { ...result.values, operation: i18n.t(`git:failure.operation.${result.operation}`) }
    : result.values
  const title = i18n.t(`git:${result.key}`, values)
  const next = result.next
  toast(
    title,
    next ? { label: i18n.t(LABEL[next]), onClick: () => runNext(projectPath, next) } : undefined,
    { tone: result.tone, dismissible: true },
  )
}

function runNext(projectPath: string, next: NextStep): void {
  switch (next) {
    case 'pull':
      void runStep(projectPath, { kind: 'pull' })
      return
    case 'push':
      pushNow(projectPath)
      return
    case 'createPr':
      openGitDialog(projectPath, { kind: 'createPr' })
      return
    case 'openPr': {
      const pr = useGitStore.getState().currentPr[projectPath]
      if (pr) window.open(pr.url, '_blank', 'noreferrer')
      return
    }
    case 'pullAndRetry':
      void (async () => {
        if (await runStep(projectPath, { kind: 'pull' })) pushNow(projectPath)
      })()
      return
    case 'showLog':
      openGitDialog(projectPath, { kind: 'log' })
      return
  }
}

/** Toasts a pull request that was just created, with Open. */
export function showCreatedPr(projectPath: string, number: number): void {
  toast(
    i18n.t('git:result.prCreated', { number }),
    { label: i18n.t(LABEL.openPr), onClick: () => runNext(projectPath, 'openPr') },
    { tone: 'success', dismissible: true },
  )
}
