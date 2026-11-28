// Runs the read-only GitHub CLI commands. Nothing here ever writes to GitHub.

import type {
  GitTools,
  Issue,
  PullRequest,
  PullRequestStackLookup,
  RepositoryReferenceSearchResult,
  RepositoryReferenceUnavailableReason,
  StackUnavailableReason,
} from '@shared/git'
import { t, tEnglish } from '../i18n'
import { logText } from '../localized-error'
import type { BranchPullRequest } from './api'
import {
  describeFailure,
  failureText,
  GH_TIMEOUT_MS,
  GIT_TIMEOUT_MS,
  type Exec,
  type ExecResult,
} from './exec'
import {
  AUTH_STATUS_ARGS,
  issueArgs,
  LIST_ARGS,
  mapAvatarUrl,
  mapBranchPullRequests,
  mapIssue,
  mapPullRequest,
  mapPullRequestStack,
  mapRepositoryReferences,
  searchReferencesArgs,
  stackArgs,
  userArgs,
  viewArgs,
} from './github'
import { isNoPullRequestMessage, parseGhAccount, parseGhVersion, parseGitVersion } from './parse'

/** A failure has `message` for the user's language and `log` in English. */
export type GhOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'not-installed' | 'failed'; message: string; log: string }

function failure(result: ExecResult): GhOutcome<never> {
  return {
    ok: false,
    reason: result.failure === 'not-found' ? 'not-installed' : 'failed',
    message: failureText(result),
    log: describeFailure(result),
  }
}

function parseJson(text: string): GhOutcome<unknown> {
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return {
      ok: false,
      reason: 'failed',
      message: t('git.failure.ghNotJson'),
      log: tEnglish('git.failure.ghNotJson'),
    }
  }
}

function mapped<T>(result: ExecResult, map: (json: unknown) => T): GhOutcome<T> {
  const json = parseJson(result.stdout)
  if (!json.ok) return json
  try {
    return { ok: true, value: map(json.value) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: 'failed', message, log: logText(error) }
  }
}

/** The pull request of the branch checked out in `cwd`, or null when the branch has none. */
export async function viewCurrentPullRequest(
  exec: Exec,
  cwd: string,
): Promise<GhOutcome<PullRequest | null>> {
  const result = await exec('gh', viewArgs(), { cwd, timeoutMs: GH_TIMEOUT_MS })
  if (result.failure === null && result.code === 1 && isNoPullRequestMessage(result.stderr)) {
    return { ok: true, value: null }
  }
  if (result.failure !== null || result.code !== 0) return failure(result)
  return mapped(result, mapPullRequest)
}

/** Pull requests of the repository by head branch, newest 50 in any state. */
export async function listBranchPullRequests(
  exec: Exec,
  cwd: string,
): Promise<GhOutcome<Map<string, BranchPullRequest>>> {
  const result = await exec('gh', LIST_ARGS, { cwd, timeoutMs: GH_TIMEOUT_MS })
  if (result.failure !== null || result.code !== 0) return failure(result)
  return mapped(result, mapBranchPullRequests)
}

/** Details of the pull request at `url`, which the caller has matched against GITHUB_PULL_REQUEST_URL. */
export async function viewPullRequestByUrl(
  exec: Exec,
  url: string,
  cwd: string,
): Promise<GhOutcome<PullRequest>> {
  const result = await exec('gh', viewArgs(url), { cwd, timeoutMs: GH_TIMEOUT_MS })
  if (result.failure !== null || result.code !== 0) return failure(result)
  return mapped(result, mapPullRequest)
}

/**
 * The issue at `url`, which the caller has matched against GITHUB_ISSUE_URL, or the `/pull/` URL
 * when GitHub says it is a pull request.
 */
export async function viewIssueByUrl(
  exec: Exec,
  url: string,
  cwd: string,
): Promise<GhOutcome<Issue | { pullRequestUrl: string }>> {
  const result = await exec('gh', issueArgs(url), { cwd, timeoutMs: GH_TIMEOUT_MS })
  if (result.failure !== null || result.code !== 0) return failure(result)
  return mapped(result, (json) => mapIssue(json, url))
}

/** The avatar URL of the user `login`, which the caller has matched against GITHUB_LOGIN. */
export async function viewAvatarUrl(
  exec: Exec,
  login: string,
  cwd: string,
): Promise<GhOutcome<string | null>> {
  const result = await exec('gh', userArgs(login), { cwd, timeoutMs: GH_TIMEOUT_MS })
  if (result.failure !== null || result.code !== 0) return failure(result)
  return mapped(result, mapAvatarUrl)
}

/** Classifies a failed `gh api` stack lookup into a clean, non-throwing fallback reason. */
export function classifyStackFailure(result: ExecResult): StackUnavailableReason {
  if (result.failure === 'not-found') return 'gh-missing'
  if (result.failure === 'timeout') return 'timeout'
  const detail = `${result.stderr}\n${result.stdout}\n${result.message}`
  if (
    /\bHTTP 401\b|not logged into|authentication failed|bad credentials|gh auth login/i.test(detail)
  ) {
    return 'gh-signed-out'
  }
  if (/\bHTTP 404\b|"status"\s*:\s*"404"|\bNot Found\b/i.test(detail)) {
    return 'not-found'
  }
  if (
    /\bHTTP 403\b|"status"\s*:\s*"403"|\bForbidden\b|Resource not accessible|SAML enforcement/i.test(
      detail,
    )
  ) {
    return 'forbidden'
  }
  return 'unavailable'
}

/**
 * Reads a GitHub pull request stack at `url` (which matches GITHUB_STACK_URL) via read-only
 * `gh api`. Always degrades to `{ kind: 'unavailable', reason }` on 404/403/auth/timeout/schema
 * mismatches so unsupported repositories never surface raw errors.
 */
export async function viewPullRequestStackByUrl(
  exec: Exec,
  url: string,
  cwd: string,
): Promise<PullRequestStackLookup> {
  const args = stackArgs(url)
  const result = await exec('gh', args, { cwd, timeoutMs: GH_TIMEOUT_MS })
  if (result.failure !== null || result.code !== 0) {
    return { kind: 'unavailable', reason: classifyStackFailure(result) }
  }
  const parsed = mapped(result, (json) => mapPullRequestStack(json, url))
  if (!parsed.ok) return { kind: 'unavailable', reason: 'unavailable' }
  return { kind: 'stack', stack: parsed.value }
}

/** Classifies a failed `gh api graphql` repository reference search into a clean fallback reason. */
export function classifyReferenceSearchFailure(
  result: ExecResult,
): RepositoryReferenceUnavailableReason {
  if (result.failure === 'not-found') return 'gh-missing'
  if (result.failure === 'timeout') return 'timeout'
  const detail = `${result.stderr}\n${result.stdout}\n${result.message}`
  if (
    /\bHTTP 401\b|not logged into|authentication failed|bad credentials|gh auth login/i.test(detail)
  ) {
    return 'gh-signed-out'
  }
  return 'failed'
}

// GitHub returns exit code 1 with partial `data` when an exact `issueOrPullRequest(number:)`
// lookup does not exist even though `search.nodes` succeeded. Accept partial payloads only when
// every GraphQL error is a NOT_FOUND on that single field.
function isOnlyMissingNumberLookup(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false
  const record = raw as Record<string, unknown>
  if (typeof record.data !== 'object' || record.data === null || Array.isArray(record.data)) {
    return false
  }
  if (!Array.isArray(record.errors) || record.errors.length === 0) return false
  return record.errors.every((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false
    const err = entry as Record<string, unknown>
    return (
      err.type === 'NOT_FOUND' &&
      Array.isArray(err.path) &&
      err.path.length === 2 &&
      err.path[0] === 'repository' &&
      err.path[1] === 'issueOrPullRequest'
    )
  })
}

/**
 * Lists recently updated issues/PRs for `owner/repo`, or searches them by number or title via
 * read-only `gh api graphql`. Never throws on missing/signed-out `gh` or transient errors.
 */
export async function searchRepositoryReferences(
  exec: Exec,
  owner: string,
  repo: string,
  query: string,
  cwd: string,
): Promise<RepositoryReferenceSearchResult> {
  const args = searchReferencesArgs(owner, repo, query)
  const result = await exec('gh', args, { cwd, timeoutMs: GH_TIMEOUT_MS })
  if (result.failure !== null) {
    return {
      kind: 'unavailable',
      reason: classifyReferenceSearchFailure(result),
      message: failureText(result),
    }
  }
  if (result.code !== 0) {
    const partial = parseJson(result.stdout)
    if (partial.ok && isOnlyMissingNumberLookup(partial.value)) {
      try {
        return { kind: 'ok', items: mapRepositoryReferences(partial.value, owner, repo) }
      } catch (error) {
        return {
          kind: 'unavailable',
          reason: 'failed',
          message: error instanceof Error ? error.message : String(error),
        }
      }
    }
    return {
      kind: 'unavailable',
      reason: classifyReferenceSearchFailure(result),
      message: failureText(result),
    }
  }
  const parsed = mapped(result, (json) => mapRepositoryReferences(json, owner, repo))
  if (!parsed.ok) {
    return { kind: 'unavailable', reason: 'failed', message: parsed.message }
  }
  return { kind: 'ok', items: parsed.value }
}

/** Whether git and gh can be used, and which account gh is signed in as. */
export async function probeTools(exec: Exec, cwd: string): Promise<GitTools> {
  const [gitVersion, ghVersion] = await Promise.all([
    exec('git', ['--version'], { cwd, timeoutMs: GIT_TIMEOUT_MS }),
    exec('gh', ['--version'], { cwd, timeoutMs: GH_TIMEOUT_MS }),
  ])
  const git: GitTools['git'] = {
    found: gitVersion.failure !== 'not-found',
    version: gitVersion.code === 0 ? parseGitVersion(gitVersion.stdout) : null,
  }
  if (ghVersion.failure === 'not-found') {
    return { git, gh: { state: 'not-installed', version: null, account: null } }
  }
  const version = ghVersion.code === 0 ? parseGhVersion(ghVersion.stdout) : null
  const auth = await exec('gh', AUTH_STATUS_ARGS, { cwd, timeoutMs: GH_TIMEOUT_MS })
  if (auth.failure === 'not-found') {
    return { git, gh: { state: 'not-installed', version: null, account: null } }
  }
  if (auth.failure !== null || auth.code !== 0) {
    return { git, gh: { state: 'signed-out', version, account: null } }
  }
  // gh prints the report to stdout, and to stderr in versions before 2.40.
  return {
    git,
    gh: { state: 'ready', version, account: parseGhAccount(`${auth.stdout}\n${auth.stderr}`) },
  }
}
