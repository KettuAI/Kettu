// Repository status and pull requests, as the git service in the agent host reports them.

import type { Platform } from './platform'

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
  /** Its tip's commit, or null on an unborn branch. */
  oid: string | null
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
/** A remote-tracking branch, such as `origin/main`. */
export interface RemoteBranchInfo {
  name: string
  oid: string
  /** Its tip's commit time. */
  committedAt: number | null
}

export interface BranchList {
  branches: BranchInfo[]
  /** The remote-tracking branches, the most recently committed first, without `<remote>/HEAD`. */
  remoteBranches: RemoteBranchInfo[]
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

export const GITHUB_STACK_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/stacks\/(\d+)$/

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

export type PullRequestStackState = 'open' | 'closed'

export interface PullRequestStackItem {
  number: number
  url: string
  state: PullRequestState
  /** Head branch name of this layer in the stack, when GitHub returns it. */
  head: string | null
  /** Pull request title, when returned by the endpoint. */
  title: string | null
}

export interface PullRequestStack {
  url: string
  owner: string
  repo: string
  number: number
  /** Optional title if GitHub includes one in the stack payload. */
  title: string | null
  state: PullRequestStackState
  /** Target base branch at the bottom of the stack, such as `main`. */
  base: string | null
  /** Ordered pull requests in the stack, from bottom to top. */
  pullRequests: PullRequestStackItem[]
  createdAt: number | null
  updatedAt: number | null
}

/** Why a pull request stack could not be read without treating it as a hard failure. */
export type StackUnavailableReason =
  'gh-missing' | 'gh-signed-out' | 'not-found' | 'forbidden' | 'timeout' | 'unavailable'

/** What a pull request stack lookup returned: its chain, or why it fell back cleanly. */
export type PullRequestStackLookup =
  | { kind: 'stack'; stack: PullRequestStack }
  | { kind: 'unavailable'; reason: StackUnavailableReason }

/** What any watched GitHub reference lookup produces for the renderer cache. */
export type ReferenceLookup = IssueLookup | PullRequestStackLookup

/** A GitHub repository identified by its owner and repository name. */
export interface GitHubRepository {
  owner: string
  repo: string
}

/** A compact issue or pull request entry returned for the composer `#` reference picker. */
export type RepositoryReferenceItem =
  | {
      kind: 'issue'
      owner: string
      repo: string
      number: number
      title: string
      url: string
      state: IssueState
      updatedAt: number
    }
  | {
      kind: 'pull'
      owner: string
      repo: string
      number: number
      title: string
      url: string
      state: PullRequestState
      updatedAt: number
    }

/** Why listing or searching repository issues/PRs degraded cleanly without blocking typing. */
export type RepositoryReferenceUnavailableReason =
  'gh-missing' | 'gh-signed-out' | 'timeout' | 'failed'

/** Read-only repository issue/PR search outcome for the composer `#` picker. */
export type RepositoryReferenceSearchResult =
  | { kind: 'ok'; items: RepositoryReferenceItem[] }
  | { kind: 'unavailable'; reason: RepositoryReferenceUnavailableReason; message?: string }

/** A pull request, issue, or pull request stack a reply names, by its canonical URL. */
export interface GitHubReference {
  kind: 'pull' | 'issue' | 'stack'
  owner: string
  repo: string
  number: number
  url: string
}

/** The reference a github.com pull request, issue, or stack URL names; null for anything else. */
export function githubReferenceOf(url: string): GitHubReference | null {
  const pull = GITHUB_PULL_REQUEST_URL.exec(url)
  const issue = pull ? null : GITHUB_ISSUE_URL.exec(url)
  const stack = pull || issue ? null : GITHUB_STACK_URL.exec(url)
  const match = pull ?? issue ?? stack
  if (!match || !isRepositoryName(match[2]!) || !GITHUB_LOGIN.test(match[1]!)) return null
  const number = Number(match[3])
  if (!Number.isSafeInteger(number) || number < 1) return null
  const kind: GitHubReference['kind'] = pull ? 'pull' : issue ? 'issue' : 'stack'
  return { kind, owner: match[1]!, repo: match[2]!, number, url }
}

/**
 * The pull request, issue, or pull request stack a github.com link points into, such as its files
 * tab or one of its comments, by its canonical URL; null for any other link.
 */
export function githubReferenceFromLink(href: string): GitHubReference | null {
  const url = URL.parse(href)
  if (!url || url.protocol !== 'https:' || url.port !== '') return null
  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return null
  if (url.username || url.password) return null
  const [owner, repo, kind, number] = url.pathname.split('/').slice(1)
  if (!owner || !repo || !number || (kind !== 'pull' && kind !== 'issues' && kind !== 'stacks'))
    return null
  if (!/^\d+$/.test(number)) return null
  return githubReferenceOf(`https://github.com/${owner}/${repo}/${kind}/${Number(number)}`)
}

// `github.com/owner/repo/pull/12` as text writes it without `https://`, with `www.` or without,
// and the part of it a link points into. Not after a letter, a dot, `@`, a slash or what a query
// holds, so `gist.github.com`, a path such as `src/github.com/...`, an email and an address
// inside another link stay out; in ASCII, so CJK punctuation right after it stays out too.
const SCHEMELESS_GITHUB_LINK =
  /(?<![\w.@/:=?&%#~+-])(?:www\.)?github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull|stacks)\/\d+(?:[/?#][\w\-./?#=&%~+:@!$*,;]*)?(?![\w-])/g

/** Where text writes a link, and the full address it stands for. */
export interface TextLink {
  from: number
  to: number
  url: string
}

/**
 * The github.com pull request and issue links text writes without `https://`, such as
 * `github.com/owner/repo/issues/12`, each without the punctuation that ends a sentence after it
 * and with the `https://` address it stands for, which names the same reference.
 */
export function schemelessGitHubLinks(text: string): TextLink[] {
  const links: TextLink[] = []
  for (const match of text.matchAll(SCHEMELESS_GITHUB_LINK)) {
    const written = match[0].replace(/[.,;:!?]+$/, '')
    const url = `https://${written}`
    if (githubReferenceFromLink(url)) {
      links.push({ from: match.index, to: match.index + written.length, url })
    }
  }
  return links
}

/** The `https://` address of text that is all one such link, else null. */
export function schemelessGitHubUrl(text: string): string | null {
  const [link] = schemelessGitHubLinks(text)
  return link && link.from === 0 && link.to === text.length ? link.url : null
}

/** A canonical URL for `owner/repo#number`; GitHub redirects `/issues/<n>` to a pull request. */
export function githubIssueUrl(owner: string, repo: string, number: number): string {
  return `https://github.com/${owner}/${repo}/issues/${number}`
}

/** A backtick-delimited inline code span `[from, to)` inside a single text block. */
export interface TextSpan {
  from: number
  to: number
}

/**
 * Finds CommonMark inline code spans delimited by matching runs of backticks within `text`
 * (without crossing a blank line). Unmatched backtick runs stay ordinary text.
 */
export function inlineCodeSpans(text: string): TextSpan[] {
  const spans: TextSpan[] = []
  let i = 0
  while (i < text.length) {
    if (text[i] !== '`') {
      i++
      continue
    }
    const openStart = i
    while (i < text.length && text[i] === '`') i++
    const ticks = i - openStart
    let j = i
    let matchedEnd = -1
    while (j < text.length) {
      if (
        (text[j] === '\n' && text[j + 1] === '\n') ||
        (text[j] === '\r' && text[j + 1] === '\n' && text[j + 2] === '\r' && text[j + 3] === '\n')
      ) {
        break
      }
      if (text[j] === '`') {
        const closeStart = j
        while (j < text.length && text[j] === '`') j++
        if (j - closeStart === ticks) {
          matchedEnd = j
          break
        }
      } else {
        j++
      }
    }
    if (matchedEnd !== -1) {
      spans.push({ from: openStart, to: matchedEnd })
      i = matchedEnd
    }
  }
  return spans
}

/** A `#123` or `owner/repo#123` GitHub reference found in prose text. */
export interface TextGitHubReference {
  from: number
  to: number
  owner: string | null
  repo: string | null
  number: number
}

// `owner/repo#12` or `#12`, starting with a non-zero digit so `#0` and `#000000` stay out, not
// after identifier/path/entity/email/hash characters, and not followed by identifier/hyphen chars
// so `#L10`, `#ff0000`, `foo#123`, `&#123;`, `##123`, and `#123-foo` stay plain text.
const TEXT_GITHUB_REFERENCE =
  /(?<![\w/&#.@-])(?:([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([\w.-]{1,100}))?#([1-9]\d{0,8})(?![\w-])/g

/**
 * Finds `#123` and `owner/repo#123` references in `text`, optionally skipping CommonMark inline
 * code spans. Callers without an associated repository should ignore bare (`owner === null`) refs.
 */
export function githubTextReferences(
  text: string,
  options?: { skipInlineCode?: boolean },
): TextGitHubReference[] {
  const skipSpans = options?.skipInlineCode ? inlineCodeSpans(text) : []
  const inCode = (from: number, to: number) =>
    skipSpans.some((span) => from < span.to && to > span.from)
  const found: TextGitHubReference[] = []
  for (const match of text.matchAll(TEXT_GITHUB_REFERENCE)) {
    const [whole, owner, repo, rawNumber] = match
    if (repo && !isRepositoryName(repo)) continue
    const from = match.index
    const to = from + whole.length
    if (inCode(from, to)) continue
    const number = Number(rawNumber)
    if (!Number.isSafeInteger(number) || number < 1) continue
    found.push({ from, to, owner: owner ?? null, repo: repo ?? null, number })
  }
  return found
}

/**
 * Resolves `#123` (and `owner/repo#123`) text references to canonical GitHub URLs when `repo` is
 * associated with the current project. Without an associated repository, returns an empty list so
 * plain-text input stays untouched.
 */
export function githubShortReferenceLinks(
  text: string,
  repo: GitHubRepository | null,
  options?: { skipInlineCode?: boolean },
): TextLink[] {
  if (!repo) return []
  const refs = githubTextReferences(text, { skipInlineCode: options?.skipInlineCode ?? true })
  return refs.map((ref) => ({
    from: ref.from,
    to: ref.to,
    url: githubIssueUrl(ref.owner ?? repo.owner, ref.repo ?? repo.repo, ref.number),
  }))
}

/** Canonical URL when `text` is exclusively a single `owner/repo#123` reference, else null. */
export function qualifiedGitHubRefUrl(text: string): string | null {
  const [ref] = githubTextReferences(text)
  if (!ref || ref.from !== 0 || ref.to !== text.length || !ref.owner || !ref.repo) return null
  return githubIssueUrl(ref.owner, ref.repo, ref.number)
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

/** A worktree's state when the user is asked what to remove. */
export interface WorktreeInspection {
  /** The folder is there and git lists it as a worktree of the project. */
  exists: boolean
  /** The branch is still there. */
  branchExists: boolean
  /** The branch's tip, or null without a branch. */
  head: string | null
  /** Changed, staged and untracked files in the worktree; 0 when it is gone. */
  uncommitted: number
  /** Commits on the branch that no remote branch has. */
  unpushed: number
  /** Every change of the branch is already in its base, by ancestry or as a squash merge. */
  merged: boolean
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

/**
 * Turns on `core.longpaths` for every git a process starts on Windows, through git's environment
 * variables after those already set, so no repository's config is changed.
 */
export function withLongPaths<E extends Record<string, string | undefined>>(
  env: E,
  platform: Platform,
): E {
  if (platform !== 'win32') return env
  const count = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10)
  const index = Number.isInteger(count) && count >= 0 ? count : 0
  return {
    ...env,
    GIT_CONFIG_COUNT: String(index + 1),
    [`GIT_CONFIG_KEY_${index}`]: 'core.longpaths',
    [`GIT_CONFIG_VALUE_${index}`]: 'true',
  }
}
