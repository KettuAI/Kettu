// Read-only paginated repository branch graph reader.

import {
  GIT_GRAPH_DEFAULT_LIMIT,
  GIT_GRAPH_MAX_LIMIT,
  GIT_GRAPH_MAX_SKIP,
  type BranchGraphCommit,
  type BranchGraphPage,
} from '@shared/git'
import { expectOk, GIT_TIMEOUT_MS, type Exec, type ExecResult } from './exec'
import { parseBranchGraphLog, parseBranchGraphRefs } from './parse'

const HEADS_PREFIX = 'refs/heads/'
const NO_COMMITS_RE = /does not have any commits yet|bad default revision 'HEAD'/i

export interface BranchGraphOptions {
  limit?: number
  skip?: number
}

function git(exec: Exec, cwd: string, args: readonly string[]): Promise<ExecResult> {
  return exec('git', args, { cwd, timeoutMs: GIT_TIMEOUT_MS })
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/**
 * Reads one page of commits across local branches, remote-tracking branches, tags, and HEAD in
 * topological order, along with each commit's refs and whether older commits remain.
 */
export async function readBranchGraph(
  exec: Exec,
  root: string,
  options: BranchGraphOptions = {},
): Promise<BranchGraphPage> {
  const limit = clampInt(options.limit ?? GIT_GRAPH_DEFAULT_LIMIT, 1, GIT_GRAPH_MAX_LIMIT)
  const skip = clampInt(options.skip ?? 0, 0, GIT_GRAPH_MAX_SKIP)

  const [headRev, symbolicHead, rawRefs] = await Promise.all([
    git(exec, root, ['rev-parse', '--verify', '--quiet', 'HEAD']),
    git(exec, root, ['symbolic-ref', '--quiet', 'HEAD']),
    git(exec, root, [
      'for-each-ref',
      '--format=%(refname)%00%(objectname)%00%(*objectname)%00%(symref)%00',
      'refs/heads',
      'refs/remotes',
      'refs/tags',
    ]),
  ])

  // Exit code 1 means unborn HEAD (no commits yet); any other failure surfaces normally.
  const headOid =
    headRev.failure === null && headRev.code === 1
      ? null
      : expectOk('git rev-parse', headRev).stdout.trim() || null

  // Exit code 1 means detached HEAD.
  const symbolicRef =
    symbolicHead.failure === null && symbolicHead.code === 1
      ? ''
      : expectOk('git symbolic-ref', symbolicHead).stdout.trim()
  const currentBranch = symbolicRef.startsWith(HEADS_PREFIX)
    ? symbolicRef.slice(HEADS_PREFIX.length)
    : null
  const detached = headOid !== null && currentBranch === null

  const refsByOid = parseBranchGraphRefs(
    expectOk('git for-each-ref', rawRefs).stdout,
    currentBranch,
    detached ? headOid : null,
  )

  // Empty repository with no commits on any branch/tag/remote.
  if (headOid === null && refsByOid.size === 0) {
    return {
      commits: [],
      headOid: null,
      currentBranch,
      detached: false,
      hasMore: false,
      nextSkip: skip,
    }
  }

  const revArgs =
    headOid !== null
      ? ['--branches', '--remotes', '--tags', 'HEAD']
      : ['--branches', '--remotes', '--tags']
  const log = await git(exec, root, [
    'log',
    ...revArgs,
    '--topo-order',
    '--no-show-signature',
    '--encoding=UTF-8',
    `--skip=${skip}`,
    `--max-count=${limit + 1}`,
    '--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%s%x1e',
  ])

  if (log.failure === null && log.code !== 0 && NO_COMMITS_RE.test(log.stderr)) {
    return {
      commits: [],
      headOid,
      currentBranch,
      detached,
      hasMore: false,
      nextSkip: skip,
    }
  }

  const parsed = parseBranchGraphLog(expectOk('git log', log).stdout)
  const hasMore = parsed.length > limit
  const pageEntries = hasMore ? parsed.slice(0, limit) : parsed
  const commits: BranchGraphCommit[] = pageEntries.map((entry) => ({
    oid: entry.oid,
    shortOid: entry.oid.slice(0, 7),
    parents: entry.parents,
    subject: entry.subject,
    authorName: entry.authorName,
    authorEmail: entry.authorEmail,
    authoredAt: entry.time * 1000,
    refs: refsByOid.get(entry.oid) ?? [],
  }))

  return {
    commits,
    headOid,
    currentBranch,
    detached,
    hasMore,
    nextSkip: skip + commits.length,
  }
}
