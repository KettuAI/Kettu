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

/** A GitHub user's login, an enterprise one with its `_shortcode`, or a bot's `<slug>[bot]`. */
export const GITHUB_LOGIN = /^[A-Za-z0-9][\w-]{0,99}(?:\[bot\])?$/

const REPOSITORY_NAME = /^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,99}$/

/** Whether GitHub accepts `name` as a repository name. */
export function isRepositoryName(name: string): boolean {
  return REPOSITORY_NAME.test(name) && name !== '.' && name !== '..'
}
