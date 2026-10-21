// What the GitHub CLI is asked for, and how its JSON maps to OverBench's pull request model.

import { GITHUB_PULL_REQUEST_URL, type PullRequest, type PullRequestState } from '@shared/git'
import type { BranchPullRequest } from './api'

const PULL_REQUEST_FIELDS =
  'number,title,state,isDraft,url,headRefName,baseRefName,reviewDecision,mergeStateStatus,statusCheckRollup,updatedAt'

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
  'number,title,state,isDraft,url,headRefName',
]

export const AUTH_STATUS_ARGS = ['auth', 'status', '--hostname', 'github.com']

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

/** Sums `statusCheckRollup`: any failure fails, else any pending run is pending. */
export function summarizeChecks(rollup: unknown): PullRequest['checks'] {
  const counts: Record<CheckOutcome, number> = { passed: 0, failed: 0, pending: 0 }
  if (Array.isArray(rollup)) {
    for (const item of rollup) {
      if (isObject(item)) counts[checkOutcome(item)]++
    }
  }
  let state: PullRequest['checks']['state'] = 'none'
  if (counts.failed > 0) state = 'failing'
  else if (counts.pending > 0) state = 'pending'
  else if (counts.passed > 0) state = 'passing'
  return { state, ...counts }
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

/** Maps the JSON of `gh pr view --json ...`; throws when it is not a pull request on github.com. */
export function mapPullRequest(raw: unknown): PullRequest {
  if (!isObject(raw)) throw new Error('Unexpected gh output: not a pull request object')
  const url = text(raw.url)
  const parts = GITHUB_PULL_REQUEST_URL.exec(url)
  if (!parts) throw new Error(`Unexpected pull request URL: ${url || '(none)'}`)
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
  }
}

/**
 * Maps the JSON of `gh pr list` to a branch lookup. When several pull requests share a
 * head branch, an open one wins over a closed one, then the first (newest) one.
 */
export function mapBranchPullRequests(raw: unknown): Map<string, BranchPullRequest> {
  if (!Array.isArray(raw)) throw new Error('Unexpected gh output: not a pull request list')
  const byBranch = new Map<string, BranchPullRequest>()
  for (const item of raw) {
    if (!isObject(item)) continue
    const branch = text(item.headRefName)
    const url = text(item.url)
    const number = typeof item.number === 'number' ? item.number : NaN
    if (!branch || !url || Number.isNaN(number)) continue
    const entry = { number, state: pullRequestState(item), url }
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
