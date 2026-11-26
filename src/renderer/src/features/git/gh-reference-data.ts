import { createContext, useContext } from 'react'
import type { GitHubReference, Issue, PullRequest } from '@shared/git'
import { PreviewFileContext, ProjectPathContext } from '@renderer/features/files/file-refs'
import { SessionIdContext } from '@renderer/features/session/media/grants'
import { sessionHost } from '@renderer/lib/host'
import { hostOfPath } from '@renderer/lib/host-paths'
import { issueOf, pullRequestOf, referenceErrorOf, useGitStore } from '@renderer/stores/git'
import { useHostScope } from '@renderer/stores/host-scope'

/**
 * Explicit host override for GitHub references rendered outside a `ProjectPathContext`
 * (for example, side chats or composer link chips without a selected project).
 */
export const GitHostContext = createContext<string | null | undefined>(undefined)

/**
 * The host whose `gh` CLI and GitHub reference cache apply here: an explicit override if given,
 * then `GitHostContext`, then the current project/preview/session's host, else the active
 * `HostScope`'s host.
 */
export function useGitHostId(explicit?: string | null): string | null {
  const fromGitHost = useContext(GitHostContext)
  const projectPath = useContext(ProjectPathContext)
  const preview = useContext(PreviewFileContext)
  const sessionId = useContext(SessionIdContext)
  const scope = useHostScope()
  if (explicit !== undefined) return explicit
  if (fromGitHost !== undefined) return fromGitHost
  if (projectPath) return hostOfPath(projectPath)
  if (preview?.projectPath) return hostOfPath(preview.projectPath)
  if (sessionId) return sessionHost(sessionId)
  return scope.hostId
}

/** What a reference names once gh has described it. */
export type ReferenceData = { kind: 'pull'; pr: PullRequest } | { kind: 'issue'; issue: Issue }

/** The details of a reference, an issue address GitHub answered with a pull request included. */
export function useReferenceData(
  ref: GitHubReference,
  explicitHostId?: string | null,
): {
  data: ReferenceData | null
  error: string | null
} {
  const hostId = useGitHostId(explicitHostId)
  const pr = useGitStore((s) => pullRequestOf(s, hostId, ref.url))
  const issue = useGitStore((s) => (ref.kind === 'issue' ? issueOf(s, hostId, ref.url) : undefined))
  const error = useGitStore((s) => referenceErrorOf(s, hostId, ref.url))
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
