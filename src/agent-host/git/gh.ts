// Runs the read-only GitHub CLI commands. Nothing here ever writes to GitHub.

import type { GitTools, PullRequest } from '@shared/git'
import type { BranchPullRequest } from './api'
import { describeFailure, GH_TIMEOUT_MS, GIT_TIMEOUT_MS, type Exec, type ExecResult } from './exec'
import {
  AUTH_STATUS_ARGS,
  LIST_ARGS,
  mapBranchPullRequests,
  mapPullRequest,
  viewArgs,
} from './github'
import { isNoPullRequestMessage, parseGhAccount, parseGhVersion, parseGitVersion } from './parse'

export type GhOutcome<T> =
  { ok: true; value: T } | { ok: false; reason: 'not-installed' | 'failed'; message: string }

function failure(result: ExecResult): GhOutcome<never> {
  return {
    ok: false,
    reason: result.failure === 'not-found' ? 'not-installed' : 'failed',
    message: describeFailure(result),
  }
}

function parseJson(text: string): GhOutcome<unknown> {
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return { ok: false, reason: 'failed', message: 'gh printed output that is not JSON' }
  }
}

function mapped<T>(result: ExecResult, map: (json: unknown) => T): GhOutcome<T> {
  const json = parseJson(result.stdout)
  if (!json.ok) return json
  try {
    return { ok: true, value: map(json.value) }
  } catch (error) {
    return {
      ok: false,
      reason: 'failed',
      message: error instanceof Error ? error.message : String(error),
    }
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
