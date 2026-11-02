// What a finished git write says in its toast, and the next step it offers. Pure, so the wording
// rules are tested on their own; `steps.ts` shows them.

import type { GitStatus } from '@shared/git'
import type { ToastTone } from '@renderer/components/ui/toast'
import type { GitOperationRequest } from '@renderer/stores/git'
import { failureOf, lastLine, type FailureKind } from './sync'

/** The action a result's toast carries. */
export type NextStep = 'pull' | 'push' | 'createPr' | 'openPr' | 'pullAndRetry' | 'showLog'

/** A git write as the failure sentences name it, a key under `failure.operation`. */
export type OperationName = 'fetch' | 'pull' | 'push' | 'publish' | 'switch' | 'commit' | 'discard'

export type ResultKey =
  | 'result.fetched'
  | 'result.fetchedNew'
  | 'result.fetchedNothing'
  | 'result.pulled'
  | 'result.pushed'
  | 'result.pushedBranch'
  | 'result.published'
  | 'result.publishedRepo'
  | 'result.created'
  | 'result.switched'
  | 'result.committed'
  | 'result.discardedOne'
  | 'result.discarded'
  | 'result.pushRejected'
  | `failure.${FailureKind}`

export interface ResultNote {
  /** A key in the `git` namespace, with its values. */
  key: ResultKey
  values: Record<string, string | number>
  /** The write a failure sentence names. */
  operation?: OperationName
  tone: ToastTone
  next: NextStep | null
}

/** The upstream's branch without its remote, as "main" for "origin/main". */
function upstreamBranch(status: GitStatus): string | null {
  const { upstream, remote } = status
  if (!upstream) return null
  const prefix = remote ? `${remote.name}/` : ''
  return prefix && upstream.name.startsWith(prefix)
    ? upstream.name.slice(prefix.length)
    : upstream.name
}

/** Whether a pull request is the step after a push: a GitHub branch other than the default. */
export function offersPullRequest(status: GitStatus, hasPr: boolean): boolean {
  return (
    !hasPr &&
    !!status.remote?.github &&
    status.head.branch !== null &&
    status.head.branch !== status.defaultBranch
  )
}

export function successNote(
  request: GitOperationRequest,
  before: GitStatus,
  after: GitStatus,
  hasPr: boolean,
): ResultNote {
  const branch = after.head.branch ?? ''
  const remote = after.remote?.name ?? ''
  const prNext = offersPullRequest(after, hasPr) ? 'createPr' : null
  switch (request.kind) {
    case 'fetch': {
      const name = upstreamBranch(after)
      if (!name) return note('result.fetched', { remote }, 'info')
      const count = after.upstream?.behind ?? 0
      return count > 0
        ? note('result.fetchedNew', { count, branch: name }, 'info', 'pull')
        : note('result.fetchedNothing', { branch: name }, 'info')
    }
    case 'pull':
      return note('result.pulled', { count: Math.max(1, before.upstream?.behind ?? 1) }, 'success')
    case 'push': {
      const count = before.upstream?.ahead ?? 0
      return count > 0
        ? note('result.pushed', { count, remote: request.remote }, 'success', prNext)
        : note('result.pushedBranch', { branch, remote: request.remote }, 'success', prNext)
    }
    case 'publishBranch':
      return note('result.published', { branch, remote: request.remote }, 'success', prNext)
    case 'publishRepo':
      return note('result.publishedRepo', { name: request.name }, 'success')
    case 'switch':
      return note(
        request.create ? 'result.created' : 'result.switched',
        { branch: request.branch },
        'success',
      )
    case 'commit': {
      const next = after.push?.kind === 'remote' || after.push?.kind === 'noRemote' ? 'push' : null
      return note('result.committed', { count: request.paths.length, branch }, 'success', next)
    }
    case 'discard':
      return request.paths.length === 1
        ? note('result.discardedOne', { name: fileName(request.paths[0]!) }, 'success')
        : note('result.discarded', { count: request.paths.length }, 'success')
  }
}

const OPERATION: Record<GitOperationRequest['kind'], OperationName> = {
  fetch: 'fetch',
  pull: 'pull',
  push: 'push',
  publishBranch: 'publish',
  publishRepo: 'publish',
  switch: 'switch',
  commit: 'commit',
  discard: 'discard',
}

export function failureNote(request: GitOperationRequest, log: string, busy: boolean): ResultNote {
  if (busy) return note('failure.busy', {}, 'warning')
  const kind = failureOf(log)
  if (request.kind === 'push' && kind === 'rejected') {
    return note('result.pushRejected', { remote: request.remote }, 'warning', 'pullAndRetry')
  }
  return {
    ...note(`failure.${kind}`, { detail: lastLine(log) }, 'warning', log ? 'showLog' : null),
    operation: OPERATION[request.kind],
  }
}

function note(
  key: ResultKey,
  values: Record<string, string | number>,
  tone: ToastTone,
  next: NextStep | null = null,
): ResultNote {
  return { key, values, tone, next }
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}
