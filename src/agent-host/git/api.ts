// The git service's interface, as the rest of the agent host uses it.

import type {
  ChangedFile,
  CommitDetails,
  FileDiff,
  GitOperation,
  GitStatus,
  GitTools,
  LogCommit,
  PullRequest,
  PullRequestState,
  RepositoryVisibility,
} from '@shared/git'
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
  fetch(projectPath: string): Promise<GitOperation>
  /**
   * The writes: one per project at a time, a second rejecting with `busy`. Each rejects with
   * git's or gh's output when the command fails, and refuses a branch that has diverged.
   */
  pull(projectPath: string): Promise<GitOperation>
  /**
   * Pushes the branch to the status's `push` target, which must still be `expected`, the target
   * the interface showed and asked about.
   */
  push(projectPath: string, expected: { remote: string; branch: string }): Promise<GitOperation>
  /** Creates a GitHub repository for a folder that has no remote, and pushes to it. */
  publish(
    projectPath: string,
    name: string,
    visibility: RepositoryVisibility,
  ): Promise<GitOperation>
  createPullRequest(
    projectPath: string,
    draft: { title: string; body: string; base: string; draft: boolean },
  ): Promise<PullRequest>
  commit(projectPath: string, oid: string): Promise<CommitDetails>
  changes(projectPath: string): Promise<ChangedFile[]>
  incoming(projectPath: string, from: 'upstream' | 'base'): Promise<LogCommit[]>
  fileDiff(
    projectPath: string,
    path: string,
    oldPath: string | null,
    ref: string | null,
  ): Promise<FileDiff>
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
