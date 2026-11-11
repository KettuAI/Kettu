// Repository status and pull requests, as the git service in the agent host reports them.

export interface GitStatus {
  projectPath: string
  repo: { root: string; gitDir: string } | null // null: not a repository
  head: {
    branch: string | null // null when detached or unborn
    oid: string | null // null on an unborn branch
    detached: boolean
  }
  upstream: { name: string; ahead: number; behind: number } | null // null: not published
  base: { name: string; ahead: number; behind: number } | null // against the default branch
  changes: {
    staged: number
    unstaged: number
    untracked: number
    conflicted: number
    insertions: number
    deletions: number
  }
  operation: { kind: 'merge' | 'rebase' | 'cherry-pick' | 'revert'; step?: [number, number] } | null
  commits: CommitSummary[] // on HEAD but not on the base, newest first, at most 20
  remote: { name: string; url: string; github: { owner: string; repo: string } | null } | null
  defaultBranch: string | null // the base's branch name, such as "main", also when HEAD is on it
  push: PushTarget | null // null when HEAD is not on a branch with a commit
  lastFetchedAt: number | null
  updatedAt: number
  stale: boolean // the last refresh failed; the values are the previous ones
}

/**
 * Where Push sends the branch, by git's own rules: `branch.<name>.pushRemote`, then
 * `remote.pushDefault`, then the upstream's remote, then `origin` or the only remote; the
 * upstream's branch when it is on that remote, else the same name, as `push.default` says.
 */
export type PushTarget =
  | {
      kind: 'remote'
      remote: string
      github: { owner: string; repo: string } | null
      branch: string // the branch on the remote, without refs/heads/
      setUpstream: boolean // the branch has no upstream yet, so the push sets one
    }
  | { kind: 'noRemote' } // the repository has no remote at all
  | { kind: 'unknownRemote' } // several remotes and nothing says which one
  | { kind: 'localUpstream' } // the upstream is a branch of this repository
  | { kind: 'otherName'; upstream: string } // push.default refuses an upstream of another name

export interface CommitSummary {
  oid: string
  subject: string
  authoredAt: number
  pushed: boolean // reachable from the upstream
}

/** A commit from a log, with its author, such as one to pull. */
export interface LogCommit extends CommitSummary {
  authorName: string
}

export type PullRequestState = 'open' | 'draft' | 'merged' | 'closed'

export interface CheckRun {
  name: string
  outcome: 'passed' | 'failed' | 'pending'
  url: string | null // an https:// link to the run's page
  startedAt: number | null
  completedAt: number | null
}

export interface PullRequest {
  url: string
  owner: string
  repo: string
  number: number
  title: string
  state: PullRequestState
  head: string
  base: string
  checks: {
    state: 'none' | 'pending' | 'passing' | 'failing'
    passed: number
    failed: number
    pending: number
    runs: CheckRun[] // failing first, then pending, then passed, each by name
  }
  review: 'approved' | 'changes_requested' | 'review_required' | null
  mergeable: 'clean' | 'conflicting' | 'blocked' | 'unknown'
  updatedAt: number
  author: PullRequestAuthor | null // null for a deleted account
  createdAt: number
  mergedAt: number | null
  closedAt: number | null
  additions: number
  deletions: number
  changedFiles: number
}

export interface PullRequestAuthor {
  login: string // a bot's as `<slug>[bot]`, its user name on GitHub
  name: string | null
  bot: boolean
}

export type ChangeStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'typechange'
  | 'untracked'
  | 'conflicted'

/** A file changed in the working tree or by a commit; paths are relative to the repository root. */
export interface ChangedFile {
  path: string
  oldPath: string | null // the path before a rename or copy
  status: ChangeStatus
  insertions: number | null // null for a binary file or an untracked one
  deletions: number | null
}

export interface CommitDetails {
  oid: string
  subject: string
  body: string // the message after the subject line, trimmed
  authorName: string
  authorEmail: string
  authoredAt: number
  files: ChangedFile[]
}

/** The two sides of one file's change; a side is null where the file does not exist. */
export interface FileDiff {
  path: string
  oldText: string | null
  newText: string | null
  binary: boolean
  tooLarge: boolean
}

/** A local branch, as the branch switcher lists it. */
export interface BranchInfo {
  name: string
  /** Its tip's commit time, or null on an unborn branch. */
  committedAt: number | null
  current: boolean
  /** The folder of another worktree that has it checked out, or null. */
  worktree: string | null
}

export interface GitRemote {
  name: string
  url: string
  github: { owner: string; repo: string } | null
}

/** The local branches, the most recently committed first, and the repository's remotes. */
export interface BranchList {
  branches: BranchInfo[]
  remotes: GitRemote[]
}

/** The result of a write such as a pull or a push: the status after it, and git's output. */
export interface GitOperation {
  status: GitStatus
  log: string
}

export type RepositoryVisibility = 'private' | 'public'

/** Whether git and the GitHub CLI are usable, for Settings › Git and the popover. */
export interface GitTools {
  git: { found: boolean; version: string | null }
  gh: {
    state: 'not-installed' | 'signed-out' | 'ready'
    version: string | null
    account: string | null
  }
}

export const GITHUB_PULL_REQUEST_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/

export const GITHUB_ISSUE_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)$/

/** `completed` and `not_planned` are the two ways GitHub closes an issue. */
export type IssueState = 'open' | 'completed' | 'not_planned'

export interface IssueLabel {
  name: string
  color: string // six hex digits, as GitHub keeps them
}

export interface Issue {
  url: string
  owner: string
  repo: string
  number: number
  title: string
  state: IssueState
  author: PullRequestAuthor | null
  labels: IssueLabel[] // the first few
  labelCount: number
  comments: number
  createdAt: number
  closedAt: number | null
  closedBy: { url: string; number: number; state: PullRequestState } | null
}

/** What an issue URL turned out to be: GitHub also serves a pull request under `/issues/`. */
export type IssueLookup =
  { kind: 'issue'; issue: Issue } | { kind: 'pull'; pullRequest: PullRequest }

/** A pull request or an issue a reply names, by its canonical URL. */
export interface GitHubReference {
  kind: 'pull' | 'issue'
  owner: string
  repo: string
  number: number
  url: string
}

/** The reference a github.com pull request or issue URL names; null for anything else. */
export function githubReferenceOf(url: string): GitHubReference | null {
  const pull = GITHUB_PULL_REQUEST_URL.exec(url)
  const match = pull ?? GITHUB_ISSUE_URL.exec(url)
  if (!match || !isRepositoryName(match[2]!) || !GITHUB_LOGIN.test(match[1]!)) return null
  const number = Number(match[3])
  if (!Number.isSafeInteger(number) || number < 1) return null
  return { kind: pull ? 'pull' : 'issue', owner: match[1]!, repo: match[2]!, number, url }
}

/**
 * The pull request or issue a github.com link points into, such as its files tab or one of its
 * comments, by its canonical URL; null for any other link.
 */
export function githubReferenceFromLink(href: string): GitHubReference | null {
  const url = URL.parse(href)
  if (!url || url.protocol !== 'https:' || url.port !== '') return null
  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return null
  if (url.username || url.password) return null
  const [owner, repo, kind, number] = url.pathname.split('/').slice(1)
  if (!owner || !repo || !number || (kind !== 'pull' && kind !== 'issues')) return null
  if (!/^\d+$/.test(number)) return null
  return githubReferenceOf(`https://github.com/${owner}/${repo}/${kind}/${Number(number)}`)
}

/** A canonical URL for `owner/repo#number`; GitHub redirects `/issues/<n>` to a pull request. */
export function githubIssueUrl(owner: string, repo: string, number: number): string {
  return `https://github.com/${owner}/${repo}/issues/${number}`
}

/** A GitHub user's login, an enterprise one with its `_shortcode`, or a bot's `<slug>[bot]`. */
export const GITHUB_LOGIN = /^[A-Za-z0-9][\w-]{0,99}(?:\[bot\])?$/

const REPOSITORY_NAME = /^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,99}$/

/** Whether GitHub accepts `name` as a repository name. */
export function isRepositoryName(name: string): boolean {
  return REPOSITORY_NAME.test(name) && name !== '.' && name !== '..'
}

/**
 * Where a session's worktree stands. `removed`: Kettu removed its folder and kept the branch, so
 * the next message recreates it; `missing`: the folder went away outside Kettu; `gone`: the
 * branch is gone too, and the session is read-only.
 */
export type WorktreeState =
  'creating' | 'setup' | 'setup-failed' | 'ready' | 'missing' | 'removed' | 'gone'

/** Why a worktree's preparation stopped, for the session's failure note. */
export interface WorktreeFailure {
  stage: 'copy' | 'setup'
  exitCode: number | null // null when the command did not exit on its own
  message: string
}

/** The worktree a session works in, as its summary carries it. */
export interface SessionWorktree {
  path: string
  branch: string
  base: string // the ref it was cut from, as named when it was created
  baseOid: string
  state: WorktreeState
  failure?: WorktreeFailure // with state 'setup-failed'
}

/** How a project prepares and names the worktrees of its sessions. */
export interface ProjectWorktreeSettings {
  branchTemplate: string
  copy: string[] // literal paths relative to the project, besides its .worktreeinclude
  setup: string | null // the command run in a new worktree
  waitForSetup: boolean // the first message waits for the command
}

export const DEFAULT_BRANCH_TEMPLATE = 'kettu/{slug}'

export const DEFAULT_WORKTREE_SETTINGS: ProjectWorktreeSettings = {
  branchTemplate: DEFAULT_BRANCH_TEMPLATE,
  copy: [],
  setup: null,
  waitForSetup: true,
}
