// What the GitHub CLI is asked for, and how its JSON maps to Kettu's pull request model.

import {
  GITHUB_ISSUE_URL,
  GITHUB_LOGIN,
  GITHUB_PULL_REQUEST_URL,
  GITHUB_STACK_URL,
  githubReferenceOf,
  isRepositoryName,
  type CheckRun,
  type Issue,
  type IssueLabel,
  type IssueState,
  type PullRequest,
  type PullRequestAuthor,
  type PullRequestStack,
  type PullRequestStackItem,
  type PullRequestStackState,
  type PullRequestState,
  type RepositoryReferenceItem,
} from '@shared/git'
import { LocalizedError } from '../localized-error'
import type { BranchPullRequest } from './api'

const PULL_REQUEST_FIELDS =
  'number,title,state,isDraft,url,headRefName,baseRefName,reviewDecision,mergeStateStatus,statusCheckRollup,updatedAt,author,createdAt,mergedAt,closedAt,additions,deletions,changedFiles'

/** Arguments of `gh pr view` for the current branch, or for one pull request URL. */
export function viewArgs(url?: string): string[] {
  return ['pr', 'view', ...(url ? [url] : []), '--json', PULL_REQUEST_FIELDS]
}

export const LIST_ARGS = [
  'pr',
  'list',
  '--state',
  'all',
  '--limit',
  '50',
  '--json',
  'number,title,state,isDraft,url,headRefName,statusCheckRollup',
]

export const AUTH_STATUS_ARGS = ['auth', 'status', '--hostname', 'github.com']

/** Arguments of `gh api` for a user, whose `avatar_url` the pull request card shows. */
export function userArgs(login: string): string[] {
  return ['api', '--hostname', 'github.com', `users/${login}`]
}

type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function pullRequestState(json: Json): PullRequestState {
  switch (text(json.state).toUpperCase()) {
    case 'MERGED':
      return 'merged'
    case 'CLOSED':
      return 'closed'
    default:
      return json.isDraft === true ? 'draft' : 'open'
  }
}

type CheckOutcome = 'passed' | 'failed' | 'pending'

// CheckRun entries carry `status` and `conclusion`; StatusContext entries carry `state`.
function checkOutcome(item: Json): CheckOutcome {
  if (item.__typename === 'StatusContext' || (!('status' in item) && 'state' in item)) {
    switch (text(item.state).toUpperCase()) {
      case 'SUCCESS':
        return 'passed'
      case 'FAILURE':
      case 'ERROR':
        return 'failed'
      default:
        return 'pending'
    }
  }
  if (text(item.status).toUpperCase() !== 'COMPLETED') return 'pending'
  switch (text(item.conclusion).toUpperCase()) {
    case 'SUCCESS':
    case 'NEUTRAL':
    case 'SKIPPED':
      return 'passed'
    case '':
      return 'pending'
    default:
      // FAILURE, TIMED_OUT, CANCELLED, STARTUP_FAILURE, ACTION_REQUIRED, STALE
      return 'failed'
  }
}

const OUTCOME_ORDER: Record<CheckOutcome, number> = { failed: 0, pending: 1, passed: 2 }

function isStatusContext(item: Json): boolean {
  return item.__typename === 'StatusContext' || (!('status' in item) && 'state' in item)
}

// GitHub shows a workflow's check as "workflow / job".
function checkName(item: Json): string {
  if (isStatusContext(item)) return text(item.context) || 'status'
  const name = text(item.name) || 'check'
  const workflow = text(item.workflowName)
  return workflow && workflow !== name ? `${workflow} / ${name}` : name
}

function httpsUrl(value: unknown): string | null {
  const url = text(value)
  return url.startsWith('https://') ? url : null
}

// A run that has not started reports 0001-01-01, which is not a time worth showing.
function timeOf(value: unknown): number | null {
  const time = Date.parse(text(value))
  return Number.isNaN(time) || time <= 0 ? null : time
}

function checkRun(item: Json): CheckRun {
  return {
    name: checkName(item),
    outcome: checkOutcome(item),
    url: httpsUrl(isStatusContext(item) ? item.targetUrl : item.detailsUrl),
    startedAt: timeOf(item.startedAt ?? item.createdAt),
    completedAt: timeOf(item.completedAt),
  }
}

/** Sums `statusCheckRollup`: any failure fails, else any pending run is pending. */
export function summarizeChecks(rollup: unknown): PullRequest['checks'] {
  const counts: Record<CheckOutcome, number> = { passed: 0, failed: 0, pending: 0 }
  const runs: CheckRun[] = []
  if (Array.isArray(rollup)) {
    for (const item of rollup) {
      if (!isObject(item)) continue
      const run = checkRun(item)
      counts[run.outcome]++
      runs.push(run)
    }
  }
  runs.sort(
    (a, b) =>
      OUTCOME_ORDER[a.outcome] - OUTCOME_ORDER[b.outcome] || a.name.localeCompare(b.name, 'en'),
  )
  let state: PullRequest['checks']['state'] = 'none'
  if (counts.failed > 0) state = 'failing'
  else if (counts.pending > 0) state = 'pending'
  else if (counts.passed > 0) state = 'passing'
  return { state, ...counts, runs }
}

function reviewOf(value: unknown): PullRequest['review'] {
  switch (text(value).toUpperCase()) {
    case 'APPROVED':
      return 'approved'
    case 'CHANGES_REQUESTED':
      return 'changes_requested'
    case 'REVIEW_REQUIRED':
      return 'review_required'
    default:
      return null
  }
}

function mergeableOf(value: unknown): PullRequest['mergeable'] {
  switch (text(value).toUpperCase()) {
    case 'CLEAN':
    case 'HAS_HOOKS':
    case 'UNSTABLE': // mergeable, with checks that are not required failing
      return 'clean'
    case 'DIRTY':
      return 'conflicting'
    case 'BLOCKED':
    case 'BEHIND':
    case 'DRAFT':
      return 'blocked'
    default:
      return 'unknown'
  }
}

// gh names a GitHub App's bot `app/<slug>`; its user on GitHub is `<slug>[bot]`.
function authorOf(value: unknown): PullRequestAuthor | null {
  if (!isObject(value)) return null
  const app = /^app\/(.+)$/.exec(text(value.login))
  const login = app ? `${app[1]}[bot]` : text(value.login)
  if (!login) return null
  return { login, name: text(value.name) || null, bot: app !== null || value.is_bot === true }
}

/** Maps the JSON of `gh pr view --json ...`; throws when it is not a pull request on github.com. */
export function mapPullRequest(raw: unknown): PullRequest {
  if (!isObject(raw)) throw new LocalizedError({ key: 'git.unexpected.pullRequestObject' })
  const url = text(raw.url)
  const parts = GITHUB_PULL_REQUEST_URL.exec(url)
  if (!parts)
    throw new LocalizedError({
      key: 'git.unexpected.pullRequestUrl',
      params: { url: url || '(none)' },
    })
  const updatedAt = Date.parse(text(raw.updatedAt))
  return {
    url,
    owner: parts[1]!,
    repo: parts[2]!,
    number: Number(parts[3]),
    title: text(raw.title),
    state: pullRequestState(raw),
    head: text(raw.headRefName),
    base: text(raw.baseRefName),
    checks: summarizeChecks(raw.statusCheckRollup),
    review: reviewOf(raw.reviewDecision),
    mergeable: mergeableOf(raw.mergeStateStatus),
    updatedAt: Number.isNaN(updatedAt) ? 0 : updatedAt,
    author: authorOf(raw.author),
    createdAt: timeOf(raw.createdAt) ?? 0,
    mergedAt: timeOf(raw.mergedAt),
    closedAt: timeOf(raw.closedAt),
    additions: count(raw.additions),
    deletions: count(raw.deletions),
    changedFiles: count(raw.changedFiles),
  }
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

const ISSUE_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issueOrPullRequest(number: $number) {
      __typename
      ... on Issue {
        url number title state stateReason createdAt closedAt
        author { __typename login ... on User { name } }
        labels(first: 3) { totalCount nodes { name color } }
        comments { totalCount }
        closedByPullRequestsReferences(first: 1, includeClosedPrs: true) {
          nodes { url number state isDraft }
        }
      }
      ... on PullRequest { url }
    }
  }
}`

/** Arguments of `gh api graphql` for the issue at `url`, which matches GITHUB_ISSUE_URL. */
export function issueArgs(url: string): string[] {
  const parts = GITHUB_ISSUE_URL.exec(url)
  if (!parts) throw new LocalizedError({ key: 'git.notIssueUrl' })
  // -f keeps owner and repo strings even when they look like numbers; -F makes the number an Int.
  return [
    'api',
    'graphql',
    '--hostname',
    'github.com',
    '-f',
    `query=${ISSUE_QUERY}`,
    '-f',
    `owner=${parts[1]}`,
    '-f',
    `repo=${parts[2]}`,
    '-F',
    `number=${parts[3]}`,
  ]
}

function graphAuthor(value: unknown): PullRequestAuthor | null {
  if (!isObject(value)) return null
  const bot = value.__typename === 'Bot'
  const login = bot ? `${text(value.login)}[bot]` : text(value.login)
  if (!text(value.login) || !GITHUB_LOGIN.test(login)) return null
  return { login, name: text(value.name) || null, bot }
}

function labelsOf(value: unknown): { labels: IssueLabel[]; labelCount: number } {
  if (!isObject(value)) return { labels: [], labelCount: 0 }
  const labels: IssueLabel[] = []
  for (const node of Array.isArray(value.nodes) ? value.nodes : []) {
    if (!isObject(node) || !text(node.name)) continue
    const color = text(node.color)
    labels.push({ name: text(node.name), color: /^[0-9a-f]{6}$/i.test(color) ? color : '' })
  }
  return { labels, labelCount: Math.max(count(value.totalCount), labels.length) }
}

function closedByOf(value: unknown): Issue['closedBy'] {
  const nodes = isObject(value) && Array.isArray(value.nodes) ? value.nodes : []
  const node: unknown = nodes[0]
  if (!isObject(node) || !GITHUB_PULL_REQUEST_URL.test(text(node.url))) return null
  if (typeof node.number !== 'number') return null
  return { url: text(node.url), number: node.number, state: pullRequestState(node) }
}

/**
 * Maps the answer to ISSUE_QUERY for `url`. A pull request under `/issues/` comes back as its
 * `/pull/` URL, which the caller reads as a pull request; anything else throws.
 */
export function mapIssue(raw: unknown, url: string): Issue | { pullRequestUrl: string } {
  const parts = GITHUB_ISSUE_URL.exec(url)
  if (!parts || !isRepositoryName(parts[2]!)) throw new LocalizedError({ key: 'git.notIssueUrl' })
  const data = isObject(raw) && isObject(raw.data) ? raw.data : null
  const repository = data && isObject(data.repository) ? data.repository : null
  const item =
    repository && isObject(repository.issueOrPullRequest) ? repository.issueOrPullRequest : null
  if (!item) throw new LocalizedError({ key: 'git.noIssue' })
  if (item.__typename === 'PullRequest') {
    const pull = `https://github.com/${parts[1]}/${parts[2]}/pull/${parts[3]}`
    return { pullRequestUrl: pull }
  }
  if (item.__typename !== 'Issue') throw new LocalizedError({ key: 'git.unexpected.issue' })
  const closed = text(item.state).toUpperCase() === 'CLOSED'
  const reason = text(item.stateReason).toUpperCase()
  return {
    url,
    owner: parts[1]!,
    repo: parts[2]!,
    number: Number(parts[3]),
    title: text(item.title),
    state: !closed
      ? 'open'
      : reason === 'NOT_PLANNED' || reason === 'DUPLICATE'
        ? 'not_planned'
        : 'completed',
    author: graphAuthor(item.author),
    ...labelsOf(item.labels),
    comments: isObject(item.comments) ? count(item.comments.totalCount) : 0,
    createdAt: timeOf(item.createdAt) ?? 0,
    closedAt: closed ? timeOf(item.closedAt) : null,
    closedBy: closed ? closedByOf(item.closedByPullRequestsReferences) : null,
  }
}

/** The `avatar_url` of `gh api users/<login>`, only when GitHub's avatar host serves it. */
export function mapAvatarUrl(raw: unknown): string | null {
  const url = isObject(raw) ? text(raw.avatar_url) : ''
  return url.startsWith('https://avatars.githubusercontent.com/') ? url : null
}

// GitHub's Stacked Pull Requests REST preview requires this API version header.
export const GITHUB_STACKS_API_VERSION = '2026-03-10'

/** Arguments of `gh api` for the pull request stack at `url`, which matches GITHUB_STACK_URL. */
export function stackArgs(url: string): string[] {
  const parts = GITHUB_STACK_URL.exec(url)
  const number = parts ? Number(parts[3]) : NaN
  if (
    !parts ||
    !isRepositoryName(parts[2]!) ||
    !GITHUB_LOGIN.test(parts[1]!) ||
    !Number.isSafeInteger(number) ||
    number < 1
  ) {
    throw new LocalizedError({ key: 'git.notStackUrl' })
  }
  return [
    'api',
    '--hostname',
    'github.com',
    '-H',
    'Accept: application/vnd.github+json',
    '-H',
    `X-GitHub-Api-Version: ${GITHUB_STACKS_API_VERSION}`,
    `repos/${parts[1]}/${parts[2]}/stacks/${number}`,
  ]
}

function restPullRequestState(item: Json): PullRequestState {
  if (item.merged === true || timeOf(item.merged_at ?? item.mergedAt) !== null) return 'merged'
  switch (text(item.state).toUpperCase()) {
    case 'MERGED':
      return 'merged'
    case 'CLOSED':
      return 'closed'
    default:
      return item.draft === true || item.isDraft === true ? 'draft' : 'open'
  }
}

function stackPullRequestItem(
  raw: unknown,
  owner: string,
  repo: string,
): PullRequestStackItem | null {
  if (!isObject(raw)) return null
  const number = typeof raw.number === 'number' ? raw.number : NaN
  if (!Number.isSafeInteger(number) || number < 1) return null
  const candidateUrl = text(raw.html_url) || text(raw.url)
  const url = GITHUB_PULL_REQUEST_URL.test(candidateUrl)
    ? candidateUrl
    : `https://github.com/${owner}/${repo}/pull/${number}`
  const head = isObject(raw.head)
    ? text(raw.head.ref).trim() || null
    : text(raw.headRefName).trim() || null
  const title = text(raw.title).trim() || null
  return { number, url, state: restPullRequestState(raw), head, title }
}

function stackStateOf(
  raw: Json,
  pullRequests: readonly PullRequestStackItem[],
): PullRequestStackState {
  const state = text(raw.state).toLowerCase()
  if (state === 'closed') return 'closed'
  if (state === 'open') return 'open'
  if (typeof raw.open === 'boolean') return raw.open ? 'open' : 'closed'
  if (
    pullRequests.length > 0 &&
    pullRequests.every((item) => item.state === 'merged' || item.state === 'closed')
  ) {
    return 'closed'
  }
  return 'open'
}

/**
 * Maps the JSON of `GET /repos/{owner}/{repo}/stacks/{stack_number}`. Optional preview fields
 * degrade to `null` rather than throwing, while non-stack payloads throw so the caller falls back.
 */
export function mapPullRequestStack(raw: unknown, url: string): PullRequestStack {
  const parts = GITHUB_STACK_URL.exec(url)
  const number = parts ? Number(parts[3]) : NaN
  if (
    !parts ||
    !isRepositoryName(parts[2]!) ||
    !GITHUB_LOGIN.test(parts[1]!) ||
    !Number.isSafeInteger(number) ||
    number < 1
  ) {
    throw new LocalizedError({ key: 'git.notStackUrl' })
  }
  if (!isObject(raw)) throw new LocalizedError({ key: 'git.unexpected.stack' })
  if (
    'pull_requests' in raw &&
    raw.pull_requests !== undefined &&
    raw.pull_requests !== null &&
    !Array.isArray(raw.pull_requests)
  ) {
    throw new LocalizedError({ key: 'git.unexpected.stack' })
  }
  const hasStackShape =
    Array.isArray(raw.pull_requests) ||
    typeof raw.open === 'boolean' ||
    typeof raw.state === 'string' ||
    isObject(raw.base)
  if (!hasStackShape) throw new LocalizedError({ key: 'git.unexpected.stack' })

  const owner = parts[1]!
  const repo = parts[2]!
  const pullRequests: PullRequestStackItem[] = []
  const seen = new Set<number>()
  if (Array.isArray(raw.pull_requests)) {
    for (const entry of raw.pull_requests) {
      const item = stackPullRequestItem(entry, owner, repo)
      if (!item || seen.has(item.number)) continue
      seen.add(item.number)
      pullRequests.push(item)
    }
  }
  const base = isObject(raw.base)
    ? text(raw.base.ref).trim() || null
    : typeof raw.base === 'string'
      ? raw.base.trim() || null
      : null
  const title = text(raw.title).trim() || text(raw.name).trim() || null
  return {
    url,
    owner,
    repo,
    number,
    title,
    state: stackStateOf(raw, pullRequests),
    base,
    pullRequests,
    createdAt: timeOf(raw.created_at ?? raw.createdAt),
    updatedAt: timeOf(raw.updated_at ?? raw.updatedAt),
  }
}

/**
 * Maps the JSON of `gh pr list` to a branch lookup. When several pull requests share a
 * head branch, an open one wins over a closed one, then the first (newest) one.
 */
export function mapBranchPullRequests(raw: unknown): Map<string, BranchPullRequest> {
  if (!Array.isArray(raw)) throw new LocalizedError({ key: 'git.unexpected.pullRequestList' })
  const byBranch = new Map<string, BranchPullRequest>()
  for (const item of raw) {
    if (!isObject(item)) continue
    const branch = text(item.headRefName)
    const url = text(item.url)
    const number = typeof item.number === 'number' ? item.number : NaN
    if (!branch || !url || Number.isNaN(number)) continue
    const state = pullRequestState(item)
    const failing =
      (state === 'open' || state === 'draft') &&
      summarizeChecks(item.statusCheckRollup).state === 'failing'
    const entry = { number, state, url, failing }
    const existing = byBranch.get(branch)
    const live = (state: PullRequestState): boolean => state === 'open' || state === 'draft'
    if (!existing || (!live(existing.state) && live(entry.state))) byBranch.set(branch, entry)
  }
  return byBranch
}

/** How long to wait before asking again: checks that are running change quickly. */
export function nextPollDelayMs(pr: PullRequest | null): number {
  return pr?.checks.state === 'pending' ? 60_000 : 300_000
}

const RECENT_REFERENCES_QUERY = `query($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
    issues(first: 25, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes { __typename number title url state stateReason updatedAt }
    }
    pullRequests(first: 25, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes { __typename number title url state isDraft updatedAt }
    }
  }
}`

const SEARCH_TEXT_REFERENCES_QUERY = `query($searchQuery: String!) {
  search(query: $searchQuery, type: ISSUE, first: 25) {
    nodes {
      __typename
      ... on Issue { number title url state stateReason updatedAt }
      ... on PullRequest { number title url state isDraft updatedAt }
    }
  }
}`

const SEARCH_NUMBER_REFERENCES_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $searchQuery: String!) {
  repository(owner: $owner, name: $repo) {
    issueOrPullRequest(number: $number) {
      __typename
      ... on Issue { number title url state stateReason updatedAt }
      ... on PullRequest { number title url state isDraft updatedAt }
    }
  }
  search(query: $searchQuery, type: ISSUE, first: 20) {
    nodes {
      __typename
      ... on Issue { number title url state stateReason updatedAt }
      ... on PullRequest { number title url state isDraft updatedAt }
    }
  }
}`

const REFERENCE_QUERY_MAX = 100

/**
 * Strips control characters, quotes, and qualifier colons from a user query before embedding it
 * inside GitHub's search syntax, keeping words safe and scoped to `repo:owner/repo`.
 */
export function sanitizeReferenceSearchTerms(query: string): string {
  let cleaned = ''
  for (const ch of query.slice(0, REFERENCE_QUERY_MAX)) {
    const code = ch.charCodeAt(0)
    cleaned += code <= 0x1f || code === 0x7f || ch === '"' || ch === '\\' || ch === ':' ? ' ' : ch
  }
  return cleaned
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean)
    .map((term) => `"${term}"`)
    .join(' ')
}

function assertRepo(owner: string, repo: string): void {
  if (!GITHUB_LOGIN.test(owner) || !isRepositoryName(repo)) {
    throw new LocalizedError({ key: 'git.notRepositoryName', params: { name: `${owner}/${repo}` } })
  }
}

/** Arguments of `gh api graphql` to list recently updated issues and PRs of `owner/repo`. */
export function recentReferencesArgs(owner: string, repo: string): string[] {
  assertRepo(owner, repo)
  return [
    'api',
    'graphql',
    '--hostname',
    'github.com',
    '-f',
    `query=${RECENT_REFERENCES_QUERY}`,
    '-f',
    `owner=${owner}`,
    '-f',
    `repo=${repo}`,
  ]
}

/**
 * Arguments of `gh api graphql` to search issues and PRs of `owner/repo` by number or title.
 * Pure positive integers also perform an exact `issueOrPullRequest(number:)` lookup so older
 * numbers outside the recent window resolve reliably.
 */
export function searchReferencesArgs(owner: string, repo: string, query: string): string[] {
  assertRepo(owner, repo)
  const trimmed = query.trim().slice(0, REFERENCE_QUERY_MAX)
  if (!trimmed) return recentReferencesArgs(owner, repo)
  const sanitized = sanitizeReferenceSearchTerms(trimmed)
  if (!sanitized) return recentReferencesArgs(owner, repo)
  const searchQuery = `repo:${owner}/${repo} ${sanitized} in:title`
  if (/^[1-9]\d{0,8}$/.test(trimmed)) {
    const number = Number(trimmed)
    return [
      'api',
      'graphql',
      '--hostname',
      'github.com',
      '-f',
      `query=${SEARCH_NUMBER_REFERENCES_QUERY}`,
      '-f',
      `owner=${owner}`,
      '-f',
      `repo=${repo}`,
      '-F',
      `number=${number}`,
      '-f',
      `searchQuery=${searchQuery}`,
    ]
  }
  return [
    'api',
    'graphql',
    '--hostname',
    'github.com',
    '-f',
    `query=${SEARCH_TEXT_REFERENCES_QUERY}`,
    '-f',
    `searchQuery=${searchQuery}`,
  ]
}

function graphIssueState(node: Json): IssueState {
  const closed = text(node.state).toUpperCase() === 'CLOSED'
  if (!closed) return 'open'
  const reason = text(node.stateReason).toUpperCase()
  return reason === 'NOT_PLANNED' || reason === 'DUPLICATE' ? 'not_planned' : 'completed'
}

function mapReferenceNode(
  raw: unknown,
  owner: string,
  repo: string,
): RepositoryReferenceItem | null {
  if (!isObject(raw)) return null
  const url = text(raw.url)
  const parsed = githubReferenceOf(url)
  if (!parsed || parsed.kind === 'stack') return null
  if (
    parsed.owner.toLowerCase() !== owner.toLowerCase() ||
    parsed.repo.toLowerCase() !== repo.toLowerCase()
  ) {
    return null
  }
  const title = text(raw.title).trim()
  if (!title) return null
  const updatedAt = timeOf(raw.updatedAt) ?? 0
  const typename = text(raw.__typename)
  if (typename === 'PullRequest' || (typename === '' && parsed.kind === 'pull')) {
    return {
      kind: 'pull',
      owner: parsed.owner,
      repo: parsed.repo,
      number: parsed.number,
      title,
      url: parsed.url,
      state: pullRequestState(raw),
      updatedAt,
    }
  }
  if (typename === 'Issue' || (typename === '' && parsed.kind === 'issue')) {
    return {
      kind: 'issue',
      owner: parsed.owner,
      repo: parsed.repo,
      number: parsed.number,
      title,
      url: parsed.url,
      state: graphIssueState(raw),
      updatedAt,
    }
  }
  return null
}

/**
 * Maps a `recentReferencesArgs` or `searchReferencesArgs` GraphQL payload into deduplicated,
 * repository-scoped issue and pull request items, ordered newest updated first.
 */
export function mapRepositoryReferences(
  raw: unknown,
  owner: string,
  repo: string,
): RepositoryReferenceItem[] {
  if (!isObject(raw) || !isObject(raw.data)) {
    throw new LocalizedError({ key: 'git.unexpected.pullRequestList' })
  }
  const data = raw.data
  const nodes: unknown[] = []
  if (isObject(data.repository)) {
    const repository = data.repository
    if (repository.issueOrPullRequest) nodes.push(repository.issueOrPullRequest)
    if (isObject(repository.issues) && Array.isArray(repository.issues.nodes)) {
      nodes.push(...repository.issues.nodes)
    }
    if (isObject(repository.pullRequests) && Array.isArray(repository.pullRequests.nodes)) {
      nodes.push(...repository.pullRequests.nodes)
    }
  }
  if (isObject(data.search) && Array.isArray(data.search.nodes)) {
    nodes.push(...data.search.nodes)
  }
  const byNumber = new Map<number, RepositoryReferenceItem>()
  for (const node of nodes) {
    const item = mapReferenceNode(node, owner, repo)
    if (!item || byNumber.has(item.number)) continue
    byNumber.set(item.number, item)
  }
  return [...byNumber.values()].sort((a, b) => b.updatedAt - a.updatedAt || b.number - a.number)
}
