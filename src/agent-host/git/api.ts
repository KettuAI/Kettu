// The git service's interface, as the rest of the agent host uses it.

import type {
  BranchList,
  ChangedFile,
  CommitDetails,
  FileDiff,
  GitOperation,
  GitStatus,
  GitTools,
  IssueLookup,
  LogCommit,
  PullRequest,
  PullRequestState,
  RepositoryVisibility,
} from '@shared/git'
import type { GitEntry, ToolKind } from '@shared/thread'

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** A git event for a session's thread; the session gives it its `g:<n>` id and `after`. */
export type GitEventDraft = DistributiveOmit<GitEntry, 'id' | 'after'>

export interface BranchPullRequest {
  number: number
  state: PullRequestState
  url: string
  failing: boolean // open with a failing check
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
  /** `git switch` to a local branch, or a new one from HEAD; refused amid a merge or conflict. */
  switchBranch(projectPath: string, branch: string, create: boolean): Promise<GitOperation>
  /** Pushes a branch that has no upstream to `remote` under its own name, and tracks it. */
  publishBranch(projectPath: string, remote: string): Promise<GitOperation>
  /**
   * Commits the working tree state of the changed files at `paths`, relative to the repository
   * root, with a rename's old path, and leaves every other change, staged or not, as it was.
   */
  commitChanges(projectPath: string, message: string, paths: string[]): Promise<GitOperation>
  /** Puts the changed files at `paths` back as HEAD has them; new files are deleted. */
  discardChanges(projectPath: string, paths: string[]): Promise<GitOperation>
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
  /** The local branches and the remotes; rejects outside a repository. */
  branches(projectPath: string): Promise<BranchList>
  /** Details for a pull request chip; `url` matches GITHUB_PULL_REQUEST_URL. */
  pullRequest(url: string): Promise<PullRequest>
  /** Details for an issue reference; `url` matches GITHUB_ISSUE_URL. */
  issue(url: string): Promise<IssueLookup>
  /** What is known of a session row's pull request without asking gh; asks in the background. */
  knownPullRequest(url: string): { state: PullRequestState; failing: boolean } | null
  /** The avatar URL of a chip's author, null when GitHub's avatar host has none; `login` matches GITHUB_LOGIN. */
  avatarUrl(login: string): Promise<string | null>
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
  /** A pull request knownPullRequest did not know has been read. */
  onPullRequestLoaded(listener: (url: string) => void): () => void
  onSessionEvents(listener: (sessionId: string, events: GitEventDraft[]) => void): () => void
  onTools(listener: (tools: GitTools) => void): () => void
  dispose(): Promise<void>
}
