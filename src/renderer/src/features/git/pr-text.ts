import type { PullRequestState } from '@shared/git'
import { i18n } from '@renderer/lib/i18n'

const STATE_KEY = {
  open: 'git:pr.state.open',
  draft: 'git:pr.state.draft',
  merged: 'git:pr.state.merged',
  closed: 'git:pr.state.closed',
} as const

/** A pull request state in the interface language; the caller re-renders through `useTranslation`. */
export function prStateText(state: PullRequestState): string {
  return i18n.t(STATE_KEY[state])
}
