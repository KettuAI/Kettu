import type { PullRequestState } from '@shared/git'

export const PR_STATE_TEXT: Record<PullRequestState, string> = {
  open: 'Open',
  draft: 'Draft',
  merged: 'Merged',
  closed: 'Closed',
}
