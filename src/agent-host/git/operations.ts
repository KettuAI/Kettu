// The writes the branch popover offers: pull, push, publishing and creating a pull request.
// Nothing here forces a push or merges; a branch that has diverged is refused before this runs.

import {
  GITHUB_PULL_REQUEST_URL,
  isRepositoryName,
  type PullRequest,
  type RepositoryVisibility,
} from '@shared/git'
import { describeFailure, type Exec, type ExecResult } from './exec'

export const SYNC_TIMEOUT_MS = 60_000
export const PUBLISH_TIMEOUT_MS = 120_000
export const CREATE_PR_TIMEOUT_MS = 60_000
/** The end of a command's output that is kept for the log. */
export const LOG_LIMIT = 64 * 1024

/** The command's output as one log, stdout first, cut to its last 64 KB. */
export function logOf(result: ExecResult): string {
  const log = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n')
  return log.length > LOG_LIMIT ? log.slice(log.length - LOG_LIMIT) : log
}

async function run(
  exec: Exec,
  cwd: string,
  file: 'git' | 'gh',
  args: string[],
  timeoutMs: number,
): Promise<string> {
  const result = await exec(file, args, { cwd, timeoutMs })
  const log = logOf(result)
  if (result.failure === 'timeout') {
    throw new Error(`${file} ${args[0]} timed out after ${timeoutMs / 1000} s\n${log}`.trim())
  }
  if (result.failure !== null || result.code !== 0) throw new Error(log || describeFailure(result))
  return log
}

/** `git pull`, fast-forward only, so a branch that needs a merge fails instead. */
export function pull(exec: Exec, cwd: string): Promise<string> {
  return run(exec, cwd, 'git', ['pull', '--ff-only', '--no-rebase'], SYNC_TIMEOUT_MS)
}

function checkRemoteName(remote: string): string {
  // Never let a remote name read as an option.
  if (remote === '' || remote.startsWith('-')) throw new Error(`Unusable remote name: ${remote}`)
  return remote
}

export interface PushTo {
  remote: string
  branch: string
  setUpstream: boolean
}

/**
 * Pushes the local branch, not HEAD, to the branch the status named, so neither a checkout since
 * then nor `push.default` can send it somewhere else.
 */
export function push(exec: Exec, cwd: string, branch: string, to: PushTo): Promise<string> {
  return run(
    exec,
    cwd,
    'git',
    [
      'push',
      '--porcelain',
      ...(to.setUpstream ? ['--set-upstream'] : []),
      checkRemoteName(to.remote),
      `refs/heads/${branch}:refs/heads/${to.branch}`,
    ],
    SYNC_TIMEOUT_MS,
  )
}

/** Creates a GitHub repository for the folder with gh, adds it as `origin` and pushes. */
export function publishRepository(
  exec: Exec,
  root: string,
  name: string,
  visibility: RepositoryVisibility,
): Promise<string> {
  if (!isRepositoryName(name)) {
    throw new Error(`Not a repository name: ${name}`)
  }
  return run(
    exec,
    root,
    'gh',
    ['repo', 'create', name, `--${visibility}`, `--source=${root}`, '--remote=origin', '--push'],
    PUBLISH_TIMEOUT_MS,
  )
}

export interface PullRequestDraft {
  /** The repository the pull request goes to, as owner/repo. */
  repo: string
  /** The branch with the commits, as owner:branch when it lives in another repository. */
  head: string
  base: string
  title: string
  body: string
  draft: boolean
}

/** Opens a pull request with gh and returns its URL. */
export async function createPullRequest(
  exec: Exec,
  cwd: string,
  draft: PullRequestDraft,
): Promise<{ url: string; log: string }> {
  // The `--flag=value` form keeps a title that starts with a dash from reading as a flag.
  const log = await run(
    exec,
    cwd,
    'gh',
    [
      'pr',
      'create',
      `--repo=${draft.repo}`,
      `--head=${draft.head}`,
      `--base=${draft.base}`,
      `--title=${draft.title}`,
      `--body=${draft.body}`,
      ...(draft.draft ? ['--draft'] : []),
    ],
    CREATE_PR_TIMEOUT_MS,
  )
  const url = log
    .split('\n')
    .map((line) => line.trim())
    .reverse()
    .find((line) => GITHUB_PULL_REQUEST_URL.test(line))
  if (!url) throw new Error(`gh did not print the new pull request's URL\n${log}`.trim())
  return { url, log }
}

/** What a new pull request is known to be before gh can describe it. */
export function createdPullRequest(
  url: string,
  head: string,
  draft: { title: string; base: string; draft: boolean },
  at: number,
): PullRequest {
  const match = GITHUB_PULL_REQUEST_URL.exec(url)
  if (!match) throw new Error(`Not a GitHub pull request URL: ${url}`)
  return {
    url,
    owner: match[1]!,
    repo: match[2]!,
    number: Number(match[3]),
    title: draft.title,
    state: draft.draft ? 'draft' : 'open',
    head,
    base: draft.base,
    checks: { state: 'none', passed: 0, failed: 0, pending: 0, runs: [] },
    review: null,
    mergeable: 'unknown',
    updatedAt: at,
  }
}
