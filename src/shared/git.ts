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
  lastFetchedAt: number | null
  updatedAt: number
  stale: boolean // the last refresh failed; the values are the previous ones
}

export interface CommitSummary {
  oid: string
  subject: string
  authoredAt: number
  pushed: boolean // reachable from the upstream
}

export type PullRequestState = 'open' | 'draft' | 'merged' | 'closed'

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
  }
  review: 'approved' | 'changes_requested' | 'review_required' | null
  mergeable: 'clean' | 'conflicting' | 'blocked' | 'unknown'
  updatedAt: number
}

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
