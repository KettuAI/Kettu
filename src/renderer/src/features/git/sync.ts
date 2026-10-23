// What the branch popover's Pull and Push buttons offer for a repository's state, and how a
// failed operation is said in the user's terms. Pure, so the rules are tested on their own.

import type { CommitSummary, GitStatus, GitTools, PushTarget } from '@shared/git'

export type OperationKind = 'fetch' | 'pull' | 'push' | 'publishBranch' | 'publishRepo'

/** Why a button cannot run; also the hint under the buttons when it needs words. */
export type SyncReason =
  | 'noBranch'
  | 'operation'
  | 'noRemote'
  | 'noUpstream'
  | 'nothingToPull'
  | 'nothingToPush'
  | 'diverged'
  | 'ghMissing'
  | 'ghSignedOut'
  | 'unknownRemote'
  | 'localUpstream'
  | 'otherName'

export interface SyncButton {
  kind: OperationKind
  count: number
  enabled: boolean
  /** The next step, which takes the default look. */
  next: boolean
  reason: SyncReason | null
}

export type SyncHint =
  | 'noBranch'
  | 'operation'
  | 'publishRepo'
  | 'publishBranch'
  | 'diverged'
  | 'upToDate'
  | 'ghMissing'
  | 'ghSignedOut'
  | 'unknownRemote'
  | 'localUpstream'
  | 'otherName'

export interface SyncPlan {
  pull: SyncButton
  push: SyncButton
  hint: SyncHint | null
}

const off = (kind: OperationKind, reason: SyncReason, count = 0): SyncButton => ({
  kind,
  count,
  enabled: false,
  next: false,
  reason,
})
const on = (kind: OperationKind, count: number): SyncButton => ({
  kind,
  count,
  enabled: true,
  next: true,
  reason: null,
})

/** Pull, by the upstream alone: a fast-forward when the branch is only behind. */
function pullButton(upstream: GitStatus['upstream']): SyncButton {
  if (!upstream) return off('pull', 'noUpstream')
  if (upstream.behind === 0) return off('pull', 'nothingToPull')
  if (upstream.ahead > 0) return off('pull', 'diverged', upstream.behind)
  return on('pull', upstream.behind)
}

/** The Pull and Push buttons for a repository, as the branch popover's table says. */
export function planSync(status: GitStatus, gh: GitTools['gh']['state'] | null): SyncPlan {
  const { head, upstream, operation, changes, push } = status
  if (head.detached || head.branch === null || head.oid === null || push === null) {
    return { pull: off('pull', 'noBranch'), push: off('push', 'noBranch'), hint: 'noBranch' }
  }
  if (operation || changes.conflicted > 0) {
    return { pull: off('pull', 'operation'), push: off('push', 'operation'), hint: 'operation' }
  }
  if (push.kind === 'noRemote') {
    if (gh !== 'ready') {
      const reason = gh === 'signed-out' ? 'ghSignedOut' : 'ghMissing'
      return { pull: off('pull', 'noRemote'), push: off('publishRepo', reason), hint: reason }
    }
    return { pull: off('pull', 'noRemote'), push: on('publishRepo', 0), hint: 'publishRepo' }
  }
  const pull = pullButton(upstream)
  if (push.kind !== 'remote') return { pull, push: off('push', push.kind), hint: push.kind }
  if (push.setUpstream) {
    return { pull, push: on('publishBranch', status.commits.length), hint: 'publishBranch' }
  }
  if (!upstream || upstream.name !== `${push.remote}/${push.branch}`) {
    // A push past the upstream, to a fork: nothing tells how far ahead it is.
    return { pull, push: { ...on('push', 0), next: false }, hint: null }
  }
  const { ahead, behind } = upstream
  if (ahead > 0 && behind > 0) {
    return { pull, push: off('push', 'diverged', ahead), hint: 'diverged' }
  }
  if (behind > 0) return { pull, push: off('push', 'nothingToPush'), hint: null }
  if (ahead > 0) return { pull, push: on('push', ahead), hint: null }
  return { pull, push: off('push', 'nothingToPush'), hint: 'upToDate' }
}

type RemoteTarget = Extract<PushTarget, { kind: 'remote' }>

/** Where a push or a branch publish goes, when it goes anywhere. */
export function pushTargetOf(status: GitStatus): RemoteTarget | null {
  return status.push?.kind === 'remote' ? status.push : null
}

/** A push or publish that would land straight on the default branch, which asks first. */
export function pushesToDefault(status: GitStatus, kind: OperationKind): boolean {
  const target = pushTargetOf(status)
  return (
    (kind === 'push' || kind === 'publishBranch') &&
    target !== null &&
    status.defaultBranch !== null &&
    target.branch === status.defaultBranch
  )
}

/** The git command a button runs, for its tooltip: the same refspec the host pushes. */
export function commandOf(status: GitStatus, kind: OperationKind): string {
  switch (kind) {
    case 'fetch':
      return 'git fetch --prune'
    case 'pull':
      return 'git pull --ff-only'
    case 'push':
    case 'publishBranch': {
      const target = pushTargetOf(status)
      if (!target) return 'git push'
      const flag = target.setUpstream ? '--set-upstream ' : ''
      return `git push ${flag}${target.remote} ${status.head.branch}:${target.branch}`
    }
    case 'publishRepo':
      return 'gh repo create --source . --push'
  }
}

/**
 * The pull request's head as gh and GitHub name it, `owner:branch` from a fork, or null when the
 * branch is not on GitHub yet or is the base itself.
 */
export function pullRequestHead(status: GitStatus): string | null {
  const base = status.remote?.github
  const target = pushTargetOf(status)
  if (!base || !target || target.setUpstream || !target.github) return null
  const sameRepo = target.github.owner === base.owner && target.github.repo === base.repo
  if (sameRepo && target.branch === status.defaultBranch) return null
  return sameRepo ? target.branch : `${target.github.owner}:${target.branch}`
}

export type FailureKind =
  | 'rejected'
  | 'notFastForward'
  | 'auth'
  | 'network'
  | 'localChanges'
  | 'remoteMissing'
  | 'nameTaken'
  | 'timeout'
  | 'busy'
  | 'other'

const FAILURES: [FailureKind, RegExp][] = [
  ['timeout', /timed out after/i],
  [
    'rejected',
    /\[rejected\]|\[remote rejected\]|non-fast-forward|fetch first|updates were rejected/i,
  ],
  ['notFastForward', /not possible to fast-forward|diverging branches|have diverged/i],
  ['localChanges', /would be overwritten by merge|commit your changes or stash them/i],
  [
    'auth',
    /authentication failed|permission denied|could not read username|terminal prompts disabled|could not read from remote repository|403/i,
  ],
  [
    'network',
    /could not resolve host|unable to access|connection (timed out|refused)|network is unreachable/i,
  ],
  ['remoteMissing', /does not appear to be a git repository|repository not found/i],
  ['nameTaken', /name already exists/i],
]

/** What a failed operation's log says, in one of the words the popover has a sentence for. */
export function failureOf(log: string): FailureKind {
  for (const [kind, pattern] of FAILURES) if (pattern.test(log)) return kind
  return 'other'
}

/** The log's last meaningful line, for a failure with no sentence of its own. */
export function lastLine(log: string): string {
  const lines = log
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  return lines.find((line) => /^(fatal|error):/i.test(line)) ?? lines.at(-1) ?? ''
}

/**
 * What a new pull request starts with: one commit gives its subject; several give the branch
 * name made readable, and their subjects, oldest first, as the description.
 */
export function suggestPullRequest(
  branch: string,
  commits: readonly CommitSummary[],
): { title: string; body: string } {
  if (commits.length === 1) return { title: commits[0]!.subject, body: '' }
  const name =
    branch
      .replace(/^[^/]+\//, '')
      .replace(/[-_]+/g, ' ')
      .trim() || branch
  return {
    title: name.charAt(0).toUpperCase() + name.slice(1),
    body: [...commits]
      .reverse()
      .map((commit) => `- ${commit.subject}`)
      .join('\n'),
  }
}

/**
 * A repository path as the Files pane names it, relative to the project, or null when the file
 * lies outside the project folder (a project can be a folder inside its repository).
 */
export function projectRelative(root: string, projectPath: string, path: string): string | null {
  const windows = root.includes('\\') || projectPath.includes('\\')
  const norm = (p: string): string => {
    const slashed = p.replace(/\\/g, '/').replace(/\/+$/, '')
    return windows ? slashed.toLowerCase() : slashed
  }
  const rootKey = norm(root)
  const projectKey = norm(projectPath)
  if (projectKey === rootKey) return path
  if (!projectKey.startsWith(rootKey + '/')) return null
  const prefix = projectKey.slice(rootKey.length + 1) + '/'
  const key = windows ? path.toLowerCase() : path
  return key.startsWith(prefix) ? path.slice(prefix.length) : null
}
