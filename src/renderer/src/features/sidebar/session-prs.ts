import type { SessionPullRequest, SessionSummary } from '@shared/agent-host'
import { githubReferenceOf } from '@shared/git'

/** A row's pull requests: the ones it opened and its branch's, or only its branch's from an older host. */
export function sessionPullRequests(summary: SessionSummary): SessionPullRequest[] {
  if (summary.prs) return summary.prs
  const pr = summary.pr
  const ref = pr ? githubReferenceOf(pr.url) : null
  if (!pr || !ref) return []
  return [
    {
      url: pr.url,
      owner: ref.owner,
      repo: ref.repo,
      number: pr.number,
      state: pr.state,
      failing: false,
    },
  ]
}
