// The git service's interface, as the rest of the agent host uses it.

import type { GitStatus, GitTools, PullRequest, PullRequestState } from '@shared/git'
import type { GitEntry, ToolKind } from '@shared/thread'

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** A git event for a session's thread; the session gives it its `g:<n>` id. */
export type GitEventDraft = DistributiveOmit<GitEntry, 'id'>

export interface BranchPullRequest {
  number: number
  state: PullRequestState
  url: string
}

export interface GitServiceDeps {
  /** The resolved agent environment, so git and gh are found as the agents find them. */
  env: NodeJS.ProcessEnv
  log(level: 'info' | 'warn' | 'error', message: string): void
}

export interface GitServiceApi {
  /** Refreshes now, coalesced with a run already in flight, and returns the status. */
  status(projectPath: string): Promise<GitStatus>
  /** Keeps a project live for one subscriber, such as a renderer port. */
  retain(projectPath: string, subscriberId: string): void
  release(projectPath: string, subscriberId: string): void
  releaseAll(subscriberId: string): void
  /** `git fetch --prune`; rejects with git's message on failure. */
  fetch(projectPath: string): Promise<GitStatus>
  /** Details for a pull request chip; `url` matches GITHUB_PULL_REQUEST_URL. */
  pullRequest(url: string): Promise<PullRequest>
  /** The current branch's pull request, from the last `gh pr view`. */
  currentPullRequest(projectPath: string): Promise<PullRequest | null>
  /** Branch name to pull request for session rows; empty until gh has answered. */
  branchPullRequests(projectPath: string): ReadonlyMap<string, BranchPullRequest>
  /** The branch checked out in the last status, or null. */
  currentBranch(projectPath: string): string | null
  tools(): Promise<GitTools>
  reloadTools(): Promise<GitTools>
  setEnvironment(env: NodeJS.ProcessEnv): void
  setBackgroundFetch(enabled: boolean): void
  /** Session events, for refreshes and for attributing commits and pushes to a session. */
  toolCallStarted(projectPath: string, sessionId: string, toolCallId: string): void
  toolCallEnded(
    projectPath: string,
    sessionId: string,
    toolCallId: string,
    toolKind: ToolKind,
    output: string,
  ): void
  turnEnded(projectPath: string, sessionId: string): void
  onChanged(listener: (status: GitStatus) => void): () => void
  onPullRequest(listener: (projectPath: string, pr: PullRequest | null) => void): () => void
  onBranchPullRequests(listener: (projectPath: string) => void): () => void
  onSessionEvents(listener: (sessionId: string, events: GitEventDraft[]) => void): () => void
  onTools(listener: (tools: GitTools) => void): () => void
  dispose(): Promise<void>
}
