import { useContext } from 'react'
import type { GitHubReference, Issue, PullRequest } from '@shared/git'
import { ProjectPathContext } from '@renderer/features/files/file-refs'
import { useGitStore } from '@renderer/stores/git'

/** What a reference names once gh has described it. */
export type ReferenceData = { kind: 'pull'; pr: PullRequest } | { kind: 'issue'; issue: Issue }

/** The details of a reference, an issue address GitHub answered with a pull request included. */
export function useReferenceData(ref: GitHubReference): {
  data: ReferenceData | null
  error: string | null
} {
  const pr = useGitStore((s) => s.pullRequests[s.pullRequestAliases[ref.url] ?? ref.url])
  const issue = useGitStore((s) => (ref.kind === 'issue' ? s.issues[ref.url] : undefined))
  const error = useGitStore((s) => s.referenceErrors[ref.url] ?? null)
  if (pr) return { data: { kind: 'pull', pr }, error: null }
  if (issue) return { data: { kind: 'issue', issue }, error: null }
  return { data: null, error }
}

/** The repository of the project a reply belongs to, which a bare `#12` and the short form name. */
export function useProjectRepository(): { owner: string; repo: string } | null {
  const projectPath = useContext(ProjectPathContext)
  return useGitStore((s) => (projectPath ? (s.status[projectPath]?.remote?.github ?? null) : null))
}

function sameRepository(ref: GitHubReference, repo: { owner: string; repo: string } | null) {
  return (
    !!repo &&
    repo.owner.toLowerCase() === ref.owner.toLowerCase() &&
    repo.repo.toLowerCase() === ref.repo.toLowerCase()
  )
}

/** `#12` in the project's own repository, else `owner/repo#12`. */
export function shortReference(
  ref: GitHubReference,
  repo: { owner: string; repo: string } | null,
): string {
  return sameRepository(ref, repo) ? `#${ref.number}` : `${ref.owner}/${ref.repo}#${ref.number}`
}
