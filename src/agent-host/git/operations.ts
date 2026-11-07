// The writes the branch popover offers: pull, push, publishing and creating a pull request,
// switching branches, and committing or discarding changed files.
// Nothing here forces a push or merges; a branch that has diverged is refused before this runs.

import {
  GITHUB_PULL_REQUEST_URL,
  isRepositoryName,
  type ChangedFile,
  type PullRequest,
  type RepositoryVisibility,
} from '@shared/git'
import { describeFailure, type Exec, type ExecResult } from './exec'

export const SYNC_TIMEOUT_MS = 60_000
export const PUBLISH_TIMEOUT_MS = 120_000
export const CREATE_PR_TIMEOUT_MS = 60_000
export const SWITCH_TIMEOUT_MS = 60_000
/** Hooks run, so a commit may take a while. */
export const COMMIT_TIMEOUT_MS = 120_000
export const DISCARD_TIMEOUT_MS = 60_000
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
    const command = args.find((arg) => !arg.startsWith('-'))
    throw new Error(`${file} ${command} timed out after ${timeoutMs / 1000} s\n${log}`.trim())
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

function checkBranchName(branch: string): string {
  if (branch === '' || branch.startsWith('-')) throw new Error(`Unusable branch name: ${branch}`)
  return branch
}

/** Switches to a local branch, never one made from a remote's, or creates one from HEAD. */
export function switchBranch(
  exec: Exec,
  cwd: string,
  branch: string,
  create: boolean,
): Promise<string> {
  return run(
    exec,
    cwd,
    'git',
    ['switch', create ? '--create' : '--no-guess', checkBranchName(branch)],
    SWITCH_TIMEOUT_MS,
  )
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

// Paths are the repository root's, as git status gives them, and never patterns.
const literal = (command: string, ...args: string[]): string[] => [
  '--literal-pathspecs',
  command,
  ...args,
]

/**
 * Commits the working tree state of `files`, from the repository root, and nothing else: the
 * index's other entries stay as they were. A rename takes its old path along.
 */
export async function commitFiles(
  exec: Exec,
  root: string,
  message: string,
  files: readonly ChangedFile[],
): Promise<string> {
  // A partial commit takes only paths git knows; a staged deletion would make `git add` fail.
  const untracked = files.filter((file) => file.status === 'untracked').map((file) => file.path)
  const paths = files.flatMap((file) =>
    file.status === 'renamed' && file.oldPath !== null ? [file.path, file.oldPath] : [file.path],
  )
  const added =
    untracked.length > 0
      ? await run(exec, root, 'git', literal('add', '--', ...untracked), COMMIT_TIMEOUT_MS)
      : ''
  let committed: string
  try {
    committed = await run(
      exec,
      root,
      'git',
      literal('commit', '-m', message, '--', ...paths),
      COMMIT_TIMEOUT_MS,
    )
  } catch (error) {
    if (untracked.length > 0) await untrackAgain(exec, root, untracked, error as Error)
    throw error
  }
  return [added, committed].filter(Boolean).join('\n')
}

// A failed commit, such as one a hook refused, leaves the files it added untracked again.
// Dropping their index entries rather than resetting them to HEAD also restores a file that
// `git rm --cached` had untracked; `--force` drops one a hook changed after it was added.
async function untrackAgain(
  exec: Exec,
  root: string,
  paths: string[],
  failure: Error,
): Promise<void> {
  const args = literal('rm', '--cached', '--force', '--quiet', '--ignore-unmatch', '--', ...paths)
  try {
    await run(exec, root, 'git', args, COMMIT_TIMEOUT_MS)
  } catch (error) {
    throw new Error(`${failure.message}\n${(error as Error).message}`, { cause: error })
  }
}

/** Puts `files` back as HEAD has them, from the repository root; new files are deleted. */
export async function discardFiles(
  exec: Exec,
  root: string,
  files: readonly ChangedFile[],
): Promise<string> {
  const remove: string[] = []
  const restore: string[] = []
  const clean: string[] = []
  for (const file of files) {
    switch (file.status) {
      case 'untracked':
        clean.push(file.path)
        break
      case 'added':
      case 'copied':
        remove.push(file.path)
        break
      case 'renamed':
        remove.push(file.path)
        if (file.oldPath !== null) restore.push(file.oldPath)
        break
      case 'conflicted':
        throw new Error(`Not discarding a conflicted file: ${file.path}`)
      default:
        restore.push(file.path)
    }
  }
  const logs: string[] = []
  if (remove.length > 0) {
    logs.push(
      await run(
        exec,
        root,
        'git',
        literal('rm', '-f', '--quiet', '--', ...remove),
        DISCARD_TIMEOUT_MS,
      ),
    )
  }
  if (restore.length > 0) {
    const args = literal('restore', '--source=HEAD', '--staged', '--worktree', '--', ...restore)
    logs.push(await run(exec, root, 'git', args, DISCARD_TIMEOUT_MS))
  }
  if (clean.length > 0) {
    logs.push(
      await run(exec, root, 'git', literal('clean', '-f', '--', ...clean), DISCARD_TIMEOUT_MS),
    )
  }
  return logs.filter(Boolean).join('\n')
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
    author: null,
    createdAt: at,
    mergedAt: null,
    closedAt: null,
    additions: 0,
    deletions: 0,
    changedFiles: 0,
  }
}
