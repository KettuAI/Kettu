// What the branch popover leads with: how far the branch is on its way to a merge, and the one
// step to take next. Pure, so the order of the steps is tested on its own.

import type { GitStatus, GitTools, PullRequest } from '@shared/git'
import { planSync, pullRequestHead, pushTargetOf, type SyncReason } from './sync'

type Gh = GitTools['gh']['state'] | null

export type JourneyId = 'uncommitted' | 'local' | 'pushed' | 'pr' | 'merge'

/** How a step of the progress line is drawn: untouched, waiting on the user, next, done or failed. */
export type JourneyTone = 'todo' | 'hold' | 'now' | 'done' | 'fail' | 'merged'

export type JourneyLabel =
  | 'uncommitted'
  | 'conflicts'
  | 'local'
  | 'toPull'
  | 'pushed'
  | 'remote'
  | 'pr'
  | 'prNumber'
  | 'merge'
  | 'merged'

export type JourneyNote =
  | 'files'
  | 'commits'
  | 'published'
  | 'notPublished'
  | 'signIn'
  | 'installGh'
  | 'checkFailed'
  | 'checksPassed'
  | 'passed'
  | 'draft'
  | 'closed'
  | 'open'
  | 'ready'
  | 'ago'

export interface JourneyStep {
  id: JourneyId
  tone: JourneyTone
  /** The number the dot shows; null shows the step's icon. */
  count: number | null
  /** The step's name, a key under `journey.label`. */
  label: JourneyLabel
  /** The line under the name, a key under `journey.note`; null leaves a dash. */
  note: JourneyNote | null
  /** A time the note names, such as when the pull request merged. */
  at: number | null
  values: Record<string, string | number>
}

export type NextKind =
  | 'conflicts'
  | 'continue'
  | 'commit'
  | 'noBranch'
  | 'publishRepo'
  | 'blocked'
  | 'diverged'
  | 'pull'
  | 'push'
  | 'publishBranch'
  | 'createPr'
  | 'fixChecks'
  | 'waiting'
  | 'merge'
  | 'merged'
  | 'closed'
  | 'upToDate'

export type NextAction =
  | 'commit'
  | 'commitAndPush'
  | 'handOffConflicts'
  | 'copyContinue'
  | 'handOffRebase'
  | 'pull'
  | 'push'
  | 'publishBranch'
  | 'publishRepo'
  | 'createPr'
  | 'openCompare'
  | 'handOffFix'
  | 'openPr'
  | 'mergeOnGitHub'
  | 'switchDefault'

export interface NextButton {
  action: NextAction
  enabled: boolean
  /** Why a disabled button cannot run. `pushFirst` is a pull request that waits for the push. */
  reason: SyncReason | 'pushFirst' | null
  /** A count the label names, such as the commits a push sends. */
  count: number
}

export type NextTone = 'primary' | 'danger' | 'warning' | 'success' | 'merged' | 'quiet'

/** The kind of operation git stopped in the middle of. */
export type StoppedOperation = NonNullable<GitStatus['operation']>['kind']

export interface NextStep {
  kind: NextKind
  /** Picks the card's wording where one kind says more than one thing. */
  variant: string | null
  tone: NextTone
  /** The operation a stop or a conflict belongs to. */
  operation: StoppedOperation | null
  values: Record<string, string | number>
  primary: NextButton | null
  secondary: NextButton | null
}

const CONTINUE_COMMAND = {
  merge: 'git merge --continue',
  rebase: 'git rebase --continue',
  'cherry-pick': 'git cherry-pick --continue',
  revert: 'git revert --continue',
} as const

/** The command that carries on a stopped operation, or null when none is stopped. */
export function continueCommand(status: GitStatus): string | null {
  return status.operation ? CONTINUE_COMMAND[status.operation.kind] : null
}

/** GitHub's page for opening a pull request from the branch, or null when it is not on GitHub. */
export function compareUrl(status: GitStatus): string | null {
  const github = status.remote?.github
  const head = pullRequestHead(status)
  if (!github || head === null || status.defaultBranch === null) return null
  const branch = head.split(':').map(encodeURIComponent).join(':')
  return `https://github.com/${github.owner}/${github.repo}/compare/${encodeURIComponent(status.defaultBranch)}...${branch}?expand=1`
}

/** Files with changes in the working tree, conflicts included. */
export function changeCount(status: GitStatus): number {
  const { staged, unstaged, untracked, conflicted } = status.changes
  return staged + unstaged + untracked + conflicted
}

/** The commits only this computer has: those past the upstream, or all of an unpublished branch. */
function unpushedCount(status: GitStatus): number {
  return status.upstream ? status.upstream.ahead : status.commits.length
}

function failingRun(pr: PullRequest): string | null {
  return failingRuns(pr)[0] ?? null
}

/** The names of the checks that failed, as the pull request lists them. */
export function failingRuns(pr: PullRequest): string[] {
  return pr.checks.runs.filter((run) => run.outcome === 'failed').map((run) => run.name)
}

/** Open, with nothing failing, nothing pending, no conflicts and no review that blocks it. */
export function readyToMerge(pr: PullRequest): boolean {
  return (
    pr.state === 'open' &&
    (pr.checks.state === 'passing' || pr.checks.state === 'none') &&
    pr.mergeable === 'clean' &&
    pr.review !== 'review_required' &&
    pr.review !== 'changes_requested'
  )
}

function step(
  id: JourneyId,
  tone: JourneyTone,
  label: JourneyLabel,
  note: JourneyNote | null,
  extra: { count?: number | null; at?: number | null; values?: JourneyStep['values'] } = {},
): JourneyStep {
  return {
    id,
    tone,
    label,
    note,
    count: extra.count ?? null,
    at: extra.at ?? null,
    values: extra.values ?? {},
  }
}

/** The five steps from uncommitted work to a merge, each with what it holds. */
export function journeyOf(status: GitStatus, pr: PullRequest | null, gh: Gh): JourneyStep[] {
  const { changes, upstream } = status
  const dirty = changeCount(status)
  const local = unpushedCount(status)
  const pushed = status.commits.filter((commit) => commit.pushed).length
  const behind = upstream?.behind ?? 0

  const first =
    changes.conflicted > 0
      ? step('uncommitted', 'fail', 'conflicts', 'files', {
          count: changes.conflicted,
          values: { count: changes.conflicted },
        })
      : dirty > 0
        ? step('uncommitted', 'hold', 'uncommitted', 'files', {
            count: dirty,
            values: { count: dirty },
          })
        : step('uncommitted', 'todo', 'uncommitted', null)

  const second =
    local > 0
      ? step('local', 'now', 'local', 'commits', { count: local, values: { count: local } })
      : step('local', 'todo', 'local', null)

  const third =
    behind > 0
      ? step('pushed', 'hold', 'toPull', 'commits', { count: behind, values: { count: behind } })
      : pushed > 0
        ? step('pushed', 'done', 'pushed', 'commits', { values: { count: pushed } })
        : step('pushed', 'todo', 'remote', upstream ? 'published' : 'notPublished')

  let fourth: JourneyStep
  let fifth: JourneyStep
  if (!pr) {
    const note = gh === 'signed-out' ? 'signIn' : gh === 'not-installed' ? 'installGh' : null
    fourth = step('pr', 'todo', 'pr', note)
    fifth = step('merge', 'todo', 'merge', null)
  } else {
    const label = 'prNumber' as const
    const values = { number: pr.number }
    const { checks } = pr
    const total = checks.passed + checks.failed + checks.pending
    const tally = { passed: checks.passed, total }
    if (pr.state === 'merged') {
      fourth = step('pr', 'done', label, 'passed', { values })
      fifth = step('merge', 'merged', 'merged', 'ago', { at: pr.mergedAt ?? pr.updatedAt })
    } else if (pr.state === 'closed') {
      fourth = step('pr', 'todo', label, 'closed', { values })
      fifth = step('merge', 'todo', 'merge', null)
    } else {
      fourth =
        pr.state === 'draft'
          ? step('pr', 'todo', label, 'draft', { values })
          : checks.state === 'failing'
            ? step('pr', 'fail', label, 'checkFailed', {
                values: { ...values, name: failingRun(pr) ?? '' },
              })
            : checks.state === 'pending'
              ? step('pr', 'hold', label, 'checksPassed', { values: { ...values, ...tally } })
              : checks.state === 'passing'
                ? step('pr', 'done', label, 'checksPassed', { values: { ...values, ...tally } })
                : step('pr', 'done', label, 'open', { values })
      fifth = readyToMerge(pr)
        ? step('merge', 'now', 'merge', 'ready')
        : step('merge', 'todo', 'merge', null)
    }
  }
  return [first, second, third, fourth, fifth]
}

const button = (
  action: NextAction,
  extra: { enabled?: boolean; reason?: NextButton['reason']; count?: number } = {},
): NextButton => ({
  action,
  enabled: extra.enabled ?? true,
  reason: extra.reason ?? null,
  count: extra.count ?? 0,
})

function next(
  kind: NextKind,
  tone: NextTone,
  primary: NextButton | null,
  secondary: NextButton | null = null,
  extra: {
    variant?: string | null
    operation?: StoppedOperation | null
    values?: NextStep['values']
  } = {},
): NextStep {
  return {
    kind,
    tone,
    primary,
    secondary,
    variant: extra.variant ?? null,
    operation: extra.operation ?? null,
    values: extra.values ?? {},
  }
}

export type WaitingVariant = 'draft' | 'conflicts' | 'checks' | 'review' | 'changes' | 'blocked'

/** Why an open pull request cannot merge yet, in the fewest words. */
export function waitingVariant(pr: PullRequest): WaitingVariant {
  if (pr.state === 'draft') return 'draft'
  if (pr.mergeable === 'conflicting') return 'conflicts'
  if (pr.checks.state === 'pending') return 'checks'
  if (pr.review === 'review_required') return 'review'
  if (pr.review === 'changes_requested') return 'changes'
  return 'blocked'
}

/** What the pull request, or the lack of one, asks next, once the branch itself is in sync. */
function afterSync(status: GitStatus, pr: PullRequest | null, gh: Gh): NextStep {
  const upstream = status.upstream?.name ?? ''
  if (pr) {
    const open = button('openPr')
    if (pr.state === 'merged') {
      const base = status.defaultBranch
      const onBase = status.head.branch === base
      return base && !onBase
        ? next('merged', 'merged', button('switchDefault'), open, { values: { base } })
        : next('merged', 'merged', open, null, { values: { base: base ?? pr.base } })
    }
    if (pr.state === 'closed') return next('closed', 'quiet', open, null)
    const failing = failingRun(pr)
    if (pr.checks.state === 'failing') {
      const count = pr.checks.failed
      return next('fixChecks', 'danger', button('handOffFix'), open, {
        values: { number: pr.number, count, name: failing ?? '' },
      })
    }
    if (readyToMerge(pr)) {
      return next('merge', 'success', button('mergeOnGitHub'), open, {
        values: {
          base: pr.base,
          count: pr.checks.passed,
          approved: pr.review === 'approved' ? 1 : 0,
        },
      })
    }
    return next('waiting', 'quiet', open, null, {
      variant: waitingVariant(pr),
      values: { base: pr.base, number: pr.number },
    })
  }

  const github = status.remote?.github
  if (github && pullRequestHead(status) !== null && status.defaultBranch) {
    const values = { base: status.defaultBranch }
    if (gh === 'ready') {
      return next('createPr', 'primary', button('createPr'), button('openCompare'), { values })
    }
    return next('createPr', 'primary', button('openCompare'), null, {
      variant: gh === 'signed-out' ? 'signedOut' : 'noGh',
      values,
    })
  }
  return next('upToDate', 'success', null, null, {
    variant: upstream ? 'synced' : 'empty',
    values: { upstream },
  })
}

/** The one step to take, by the order of the branch popover's table: the first that applies. */
export function nextStepOf(status: GitStatus, pr: PullRequest | null, gh: Gh): NextStep {
  const { head, upstream, operation, changes } = status
  const plan = planSync(status, gh)

  if (changes.conflicted > 0 || operation) {
    const stopped = operation?.kind ?? null
    if (changes.conflicted > 0) {
      return next(
        'conflicts',
        'danger',
        button('handOffConflicts'),
        operation ? button('copyContinue') : null,
        { operation: stopped, values: { count: changes.conflicted } },
      )
    }
    return next('continue', 'warning', button('copyContinue'), null, { operation: stopped })
  }

  const dirty = changeCount(status)
  if (dirty > 0) {
    const target = pushTargetOf(status)
    const diverged = plan.push.reason === 'diverged'
    const secondary = target
      ? button('commitAndPush', {
          enabled: !diverged,
          reason: diverged ? 'diverged' : null,
        })
      : null
    const context =
      pr && pr.state === 'open' && pr.checks.state === 'failing'
        ? 'checks'
        : target?.setUpstream
          ? 'unpublished'
          : ''
    return next('commit', 'primary', button('commit'), secondary, {
      variant: target?.setUpstream ? 'publish' : null,
      values: {
        count: dirty,
        insertions: changes.insertions,
        deletions: changes.deletions,
        context,
        name: pr ? (failingRun(pr) ?? '') : '',
      },
    })
  }

  if (head.detached || head.branch === null || head.oid === null || status.push === null) {
    return next('noBranch', 'quiet', null, null, {
      variant: head.detached ? 'detached' : 'unborn',
    })
  }

  if (plan.push.kind === 'publishRepo') {
    return next(
      'publishRepo',
      'primary',
      button('publishRepo', { enabled: plan.push.enabled, reason: plan.push.reason }),
    )
  }

  if (upstream && upstream.ahead > 0 && upstream.behind > 0) {
    return next(
      'diverged',
      'warning',
      button('handOffRebase'),
      button('pull', { enabled: false, reason: 'diverged', count: upstream.behind }),
      { values: { upstream: upstream.name } },
    )
  }
  if (upstream && upstream.behind > 0) {
    return next(
      'pull',
      'primary',
      button('pull', { enabled: plan.pull.enabled, count: upstream.behind }),
      null,
      {
        values: { count: upstream.behind, upstream: upstream.name },
      },
    )
  }

  if (plan.push.kind !== 'push' && plan.push.kind !== 'publishBranch') {
    // Several remotes, a local upstream or another name: git has nowhere to push, and says why.
    return next('blocked', 'warning', null, null, {
      variant: plan.push.kind,
      values: { upstream: status.upstream?.name ?? '' },
    })
  }

  if (plan.push.kind === 'publishBranch') {
    if (status.commits.length === 0) return afterSync(status, pr, gh)
    return next(
      'publishBranch',
      'primary',
      button('publishBranch', { enabled: plan.push.enabled, reason: plan.push.reason }),
      null,
      { values: { count: status.commits.length, remote: pushTargetOf(status)?.remote ?? '' } },
    )
  }

  if (upstream && upstream.ahead > 0) {
    const offerPr =
      !pr &&
      !!status.remote?.github &&
      gh === 'ready' &&
      status.defaultBranch !== null &&
      head.branch !== status.defaultBranch
    return next(
      'push',
      'primary',
      button('push', {
        enabled: plan.push.enabled,
        reason: plan.push.reason,
        count: upstream.ahead,
      }),
      offerPr ? button('createPr', { enabled: false, reason: 'pushFirst' }) : null,
      {
        variant: offerPr
          ? 'pr'
          : pr && (pr.state === 'open' || pr.state === 'draft')
            ? 'updatesPr'
            : null,
        values: {
          count: upstream.ahead,
          remote: pushTargetOf(status)?.remote ?? '',
          number: pr?.number ?? 0,
        },
      },
    )
  }

  return afterSync(status, pr, gh)
}
