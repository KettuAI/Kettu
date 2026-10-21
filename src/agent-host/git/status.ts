// One status refresh: the commands of the design's table, run for one project folder.

import { stat, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { CommitSummary, GitStatus } from '@shared/git'
import { CommandError, expectOk, GIT_TIMEOUT_MS, type Exec, type ExecResult } from './exec'
import {
  parseConfigEntries,
  parseGithubRemote,
  parseLeftRightCount,
  parseLog,
  parseOidLines,
  parsePorcelainStatus,
  parseShortstat,
  pickRemote,
  type PorcelainStatus,
} from './parse'

export interface RepoInfo {
  root: string
  gitDir: string
  /** Where refs and config live; differs from `gitDir` in a linked worktree. */
  commonDir: string
}

/** What survives between refreshes of one project. */
export interface RepoCache {
  repo: RepoInfo | null
  config: { signature: string; entries: [string, string][] } | null
}

export function createRepoCache(): RepoCache {
  return { repo: null, config: null }
}

export interface StatusContext {
  projectPath: string
  exec: Exec
  cache: RepoCache
  now(): number
}

const COMMIT_LIMIT = 20
// Bounds the list of unpushed commits; the newest ones are all that can be on screen.
const UNPUSHED_LIMIT = 1000
const NOT_A_REPOSITORY = /not a git repository|must be run in a work tree/i

export function emptyStatus(projectPath: string, now: number): GitStatus {
  return {
    projectPath,
    repo: null,
    head: { branch: null, oid: null, detached: false },
    upstream: null,
    base: null,
    changes: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0, insertions: 0, deletions: 0 },
    operation: null,
    commits: [],
    remote: null,
    lastFetchedAt: null,
    updatedAt: now,
    stale: false,
  }
}

/** Runs one refresh. Throws a CommandError when git fails; a non-repository is a result. */
export async function readStatus(ctx: StatusContext): Promise<GitStatus> {
  const info = await resolveRepo(ctx)
  if (!info) return emptyStatus(ctx.projectPath, ctx.now())

  const [statusResult, operation, lastFetchedAt, config] = await Promise.all([
    git(ctx, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal']),
    readOperation(info.gitDir),
    readLastFetchedAt(info),
    readConfig(ctx, info),
  ])
  const parsed = parsePorcelainStatus(expectOk('git status', statusResult).stdout)
  const unborn = parsed.oid === null
  // An unborn branch has a name in git's output but no commit to show or compare.
  const branch = unborn ? null : parsed.branch
  const upstream =
    parsed.upstream !== null && parsed.ahead !== null
      ? { name: parsed.upstream, ahead: parsed.ahead, behind: parsed.behind }
      : null

  const remoteInfo = pickRemote(config, branch)
  const remote = remoteInfo && {
    name: remoteInfo.name,
    url: remoteInfo.url,
    github: parseGithubRemote(remoteInfo.url),
  }

  const hasTrackedChanges = parsed.staged + parsed.unstaged + parsed.conflicted > 0
  const [diffStat, baseRef] = await Promise.all([
    hasTrackedChanges && !unborn ? readShortstat(ctx) : { insertions: 0, deletions: 0 },
    unborn ? null : resolveBaseRef(ctx, remote?.name ?? null),
  ])

  const onBase =
    baseRef !== null && branch !== null && branch === branchOfRef(baseRef, remote?.name)
  const comparedBase = onBase ? null : baseRef
  const [base, commits] = await Promise.all([
    comparedBase === null ? null : readBase(ctx, comparedBase),
    unborn ? [] : readCommits(ctx, comparedBase, upstream),
  ])

  return {
    projectPath: ctx.projectPath,
    repo: { root: info.root, gitDir: info.gitDir },
    head: { branch, oid: parsed.oid, detached: parsed.detached },
    upstream,
    base,
    changes: changeCounts(parsed, diffStat),
    operation,
    commits,
    remote,
    lastFetchedAt,
    updatedAt: ctx.now(),
    stale: false,
  }
}

function changeCounts(
  parsed: PorcelainStatus,
  stat: { insertions: number; deletions: number },
): GitStatus['changes'] {
  return {
    staged: parsed.staged,
    unstaged: parsed.unstaged,
    untracked: parsed.untracked,
    conflicted: parsed.conflicted,
    insertions: stat.insertions,
    deletions: stat.deletions,
  }
}

function git(ctx: StatusContext, args: string[]): Promise<ExecResult> {
  return ctx.exec('git', args, { cwd: ctx.projectPath, timeoutMs: GIT_TIMEOUT_MS })
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function resolveRepo(ctx: StatusContext): Promise<RepoInfo | null> {
  const cached = ctx.cache.repo
  if (cached && (await exists(join(cached.gitDir, 'HEAD')))) return cached
  ctx.cache.repo = null

  const result = await git(ctx, [
    'rev-parse',
    '--show-toplevel',
    '--absolute-git-dir',
    '--git-common-dir',
  ])
  if (result.failure === 'cwd-missing') return null
  if (result.failure === null && result.code !== 0 && NOT_A_REPOSITORY.test(result.stderr)) {
    return null
  }
  expectOk('git rev-parse', result)

  const [root, gitDir, commonDir] = result.stdout.split(/\r?\n/)
  if (!root || !gitDir || !commonDir) {
    throw new CommandError('git rev-parse', { ...result, message: 'unexpected output' })
  }
  ctx.cache.repo = {
    root: resolve(root),
    gitDir: resolve(gitDir),
    // Relative to the folder the command ran in.
    commonDir: resolve(ctx.projectPath, commonDir),
  }
  return ctx.cache.repo
}

// The remote entries only change with the repository's config file.
async function readConfig(ctx: StatusContext, info: RepoInfo): Promise<[string, string][]> {
  const signature = await fileSignature(join(info.commonDir, 'config'))
  if (ctx.cache.config?.signature === signature) return ctx.cache.config.entries
  const result = await git(ctx, [
    'config',
    '--local',
    '-z',
    '--get-regexp',
    '^(remote\\..+\\.url|branch\\..+\\.remote)$',
  ])
  // Exit code 1 means no entry matched.
  if (result.failure === null && result.code === 1) {
    ctx.cache.config = { signature, entries: [] }
    return []
  }
  const entries = parseConfigEntries(expectOk('git config', result).stdout)
  ctx.cache.config = { signature, entries }
  return entries
}

async function fileSignature(path: string): Promise<string> {
  try {
    const info = await stat(path)
    return `${info.mtimeMs}:${info.size}`
  } catch {
    return 'missing'
  }
}

async function readShortstat(
  ctx: StatusContext,
): Promise<{ insertions: number; deletions: number }> {
  const result = await git(ctx, ['diff', '--shortstat', '--no-ext-diff', 'HEAD', '--'])
  return parseShortstat(expectOk('git diff', result).stdout)
}

/**
 * The branch commits are compared with: the remote's default branch, else `main`, else
 * `master`, preferring the remote-tracking copy. One `for-each-ref` answers all of it.
 */
async function resolveBaseRef(ctx: StatusContext, remote: string | null): Promise<string | null> {
  const patterns = ['refs/heads/main', 'refs/heads/master']
  if (remote !== null) {
    patterns.push(
      `refs/remotes/${remote}/HEAD`,
      `refs/remotes/${remote}/main`,
      `refs/remotes/${remote}/master`,
    )
  }
  const result = expectOk(
    'git for-each-ref',
    await git(ctx, ['for-each-ref', '--format=%(refname)%00%(symref)', ...patterns]),
  )
  const refs = new Set<string>()
  let defaultRef: string | null = null
  for (const line of result.stdout.split('\n')) {
    const [refname, symref] = line.split('\0')
    if (!refname) continue
    refs.add(refname)
    if (remote !== null && refname === `refs/remotes/${remote}/HEAD` && symref) defaultRef = symref
  }

  if (defaultRef !== null && (refs.has(defaultRef) || (await refExists(ctx, defaultRef)))) {
    return shortName(defaultRef)
  }
  const candidates =
    remote === null
      ? ['refs/heads/main', 'refs/heads/master']
      : [
          `refs/remotes/${remote}/main`,
          'refs/heads/main',
          `refs/remotes/${remote}/master`,
          'refs/heads/master',
        ]
  const found = candidates.find((ref) => refs.has(ref))
  return found ? shortName(found) : null
}

async function refExists(ctx: StatusContext, ref: string): Promise<boolean> {
  const result = await git(ctx, ['rev-parse', '--verify', '--quiet', ref])
  if (result.failure === null && result.code === 1) return false
  expectOk('git rev-parse', result)
  return true
}

function shortName(ref: string): string {
  return ref.replace(/^refs\/(?:heads|remotes)\//, '')
}

/** The branch name a base ref stands for, such as `main` for `origin/main`. */
function branchOfRef(ref: string, remote: string | undefined): string {
  return remote !== undefined && ref.startsWith(`${remote}/`) ? ref.slice(remote.length + 1) : ref
}

async function readBase(ctx: StatusContext, baseRef: string): Promise<GitStatus['base']> {
  const result = await git(ctx, ['rev-list', '--left-right', '--count', `${baseRef}...HEAD`, '--'])
  const { left, right } = parseLeftRightCount(expectOk('git rev-list', result).stdout)
  return { name: baseRef, ahead: right, behind: left }
}

// Without a base, or on the base itself, the commits worth listing are the unpushed ones.
async function readCommits(
  ctx: StatusContext,
  baseRef: string | null,
  upstream: GitStatus['upstream'],
): Promise<CommitSummary[]> {
  const range = baseRef ? `${baseRef}..HEAD` : upstream ? `${upstream.name}..HEAD` : 'HEAD'
  const listUnpushed = baseRef !== null && upstream !== null && upstream.ahead > 0
  const [log, unpushed] = await Promise.all([
    git(ctx, [
      'log',
      '-n',
      String(COMMIT_LIMIT),
      '--no-show-signature',
      '--encoding=UTF-8',
      '--format=%H%x00%s%x00%at',
      range,
      '--',
    ]),
    listUnpushed
      ? git(ctx, ['rev-list', `--max-count=${UNPUSHED_LIMIT}`, `${upstream.name}..HEAD`, '--'])
      : null,
  ])
  const notPushed = new Set(
    unpushed ? parseOidLines(expectOk('git rev-list', unpushed).stdout) : [],
  )
  const rangeIsUnpushed = baseRef === null
  return parseLog(expectOk('git log', log).stdout).map((line) => ({
    oid: line.oid,
    subject: line.subject,
    authoredAt: line.time * 1000,
    pushed: upstream !== null && !rangeIsUnpushed && !notPushed.has(line.oid),
  }))
}

async function readOperation(gitDir: string): Promise<GitStatus['operation']> {
  const has = (name: string): Promise<boolean> => exists(join(gitDir, name))
  const [rebaseMerge, rebaseApply, applying, merge, cherryPick, revert] = await Promise.all([
    has('rebase-merge'),
    has('rebase-apply'),
    has(join('rebase-apply', 'applying')),
    has('MERGE_HEAD'),
    has('CHERRY_PICK_HEAD'),
    has('REVERT_HEAD'),
  ])
  if (rebaseMerge) return rebase(await readStep(gitDir, 'rebase-merge', 'msgnum', 'end'))
  // rebase-apply is also where `git am` keeps its state, which is not an operation we show.
  if (rebaseApply && !applying)
    return rebase(await readStep(gitDir, 'rebase-apply', 'next', 'last'))
  if (merge) return { kind: 'merge' }
  if (cherryPick) return { kind: 'cherry-pick' }
  if (revert) return { kind: 'revert' }
  return null
}

function rebase(step: [number, number] | undefined): GitStatus['operation'] {
  return step ? { kind: 'rebase', step } : { kind: 'rebase' }
}

async function readStep(
  gitDir: string,
  dir: string,
  currentFile: string,
  totalFile: string,
): Promise<[number, number] | undefined> {
  const [current, total] = await Promise.all([
    readNumber(join(gitDir, dir, currentFile)),
    readNumber(join(gitDir, dir, totalFile)),
  ])
  return current !== null && total !== null && total > 0 ? [current, total] : undefined
}

async function readNumber(path: string): Promise<number | null> {
  try {
    const value = Number.parseInt((await readFile(path, 'utf8')).trim(), 10)
    return Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

async function readLastFetchedAt(info: RepoInfo): Promise<number | null> {
  const paths = new Set([join(info.gitDir, 'FETCH_HEAD'), join(info.commonDir, 'FETCH_HEAD')])
  let latest: number | null = null
  await Promise.all(
    [...paths].map(async (path) => {
      try {
        const time = Math.floor((await stat(path)).mtimeMs)
        if (latest === null || time > latest) latest = time
      } catch {
        // No fetch has run here.
      }
    }),
  )
  return latest
}
