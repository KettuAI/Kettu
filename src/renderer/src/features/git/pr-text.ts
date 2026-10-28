import type { PullRequest, PullRequestState } from '@shared/git'
import { i18n } from '@renderer/lib/i18n'

const STATE_KEY = {
  open: 'git:pr.state.open',
  draft: 'git:pr.state.draft',
  merged: 'git:pr.state.merged',
  closed: 'git:pr.state.closed',
} as const

/** The words for a review decision, in the `git` namespace. */
export const REVIEW_KEY = {
  approved: 'pr.review.approved',
  changes_requested: 'pr.review.changesRequested',
  review_required: 'pr.review.reviewRequired',
} as const

/** A pull request state in the interface language; the caller re-renders through `useTranslation`. */
export function prStateText(state: PullRequestState): string {
  return i18n.t(STATE_KEY[state])
}

/** "7 passed · 1 pending · 2 failed", without the counts that are none. */
export function checkCountText(checks: PullRequest['checks']): string {
  return [
    checks.passed > 0 && i18n.t('git:pr.checkCount.passed', { count: checks.passed }),
    checks.pending > 0 && i18n.t('git:pr.checkCount.pending', { count: checks.pending }),
    checks.failed > 0 && i18n.t('git:pr.checkCount.failed', { count: checks.failed }),
  ]
    .filter(Boolean)
    .join(' · ')
}
