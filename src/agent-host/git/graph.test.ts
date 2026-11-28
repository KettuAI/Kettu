import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { GitServiceApi } from './api'
import { createGitService } from './service'

const BASE_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Graph Tester',
  GIT_AUTHOR_EMAIL: 'tester@example.com',
  GIT_COMMITTER_NAME: 'Graph Tester',
  GIT_COMMITTER_EMAIL: 'tester@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
}

let commitClock = 1_700_000_000

function git(cwd: string, ...args: string[]): string {
  commitClock += 60
  const date = `${commitClock} +0000`
  return execFileSync('git', args, {
    cwd,
    env: { ...BASE_ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

describe('git.graph, commit details, and diffs against real repositories', () => {
  let rootTmp: string
  let repoDir: string
  let emptyRepoDir: string
  let nonRepoDir: string
  let service: GitServiceApi
  let rootOid: string
  let mergeOid: string
  let featOid: string
  let mainHeadOid: string

  beforeAll(async () => {
    rootTmp = await realpath(await mkdtemp(path.join(tmpdir(), 'kettu-git-graph-')))
    repoDir = path.join(rootTmp, 'repo')
    emptyRepoDir = path.join(rootTmp, 'empty')
    nonRepoDir = path.join(rootTmp, 'not-a-repo')
    await Promise.all([
      mkdir(repoDir, { recursive: true }),
      mkdir(emptyRepoDir, { recursive: true }),
      mkdir(nonRepoDir, { recursive: true }),
    ])

    git(emptyRepoDir, 'init', '-q', '-b', 'main')

    // Build a repository with forks, a merge, tags (lightweight + annotated), and a remote ref.
    git(repoDir, 'init', '-q', '-b', 'main')
    await writeFile(path.join(repoDir, 'readme.md'), 'hello\n')
    git(repoDir, 'add', '.')
    git(repoDir, 'commit', '-q', '-m', 'initial commit')
    rootOid = git(repoDir, 'rev-parse', 'HEAD')
    git(repoDir, 'tag', 'v0.1.0')

    // Fork feature branch.
    git(repoDir, 'checkout', '-q', '-b', 'feat/graph')
    await writeFile(path.join(repoDir, 'feature.txt'), 'line 1\nline 2\n')
    git(repoDir, 'add', '.')
    git(repoDir, 'commit', '-q', '-m', 'add feature file\n\nDetailed commit body here.')
    featOid = git(repoDir, 'rev-parse', 'HEAD')

    // Advance main and merge feat/graph with --no-ff.
    git(repoDir, 'checkout', '-q', 'main')
    await writeFile(path.join(repoDir, 'readme.md'), 'hello\nworld\n')
    git(repoDir, 'add', '.')
    git(repoDir, 'commit', '-q', '-m', 'update readme on main')

    git(repoDir, 'merge', '-q', '--no-ff', 'feat/graph', '-m', 'merge feat/graph into main')
    mergeOid = git(repoDir, 'rev-parse', 'HEAD')
    git(repoDir, 'tag', '-a', 'v1.0.0', '-m', 'Release v1.0.0')

    // Add a side branch still ahead of root, plus a remote tracking ref and symbolic origin/HEAD.
    git(repoDir, 'checkout', '-q', '-b', 'side/extra', rootOid)
    await writeFile(path.join(repoDir, 'extra.txt'), 'extra\n')
    git(repoDir, 'add', '.')
    git(repoDir, 'commit', '-q', '-m', 'extra side branch commit')
    git(repoDir, 'checkout', '-q', 'main')

    mainHeadOid = mergeOid
    git(repoDir, 'update-ref', 'refs/remotes/origin/main', mainHeadOid)
    git(repoDir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')

    service = createGitService({ env: BASE_ENV, log: () => {} })
  })

  afterAll(async () => {
    await service.dispose()
    await rm(rootTmp, { recursive: true, force: true })
  })

  it('reads all branches, refs, annotated tags, merges, and current branch accurately', async () => {
    const page = await service.graph(repoDir, { limit: 20, skip: 0 })
    expect(page.currentBranch).toBe('main')
    expect(page.detached).toBe(false)
    expect(page.headOid).toBe(mainHeadOid)
    expect(page.hasMore).toBe(false)
    expect(page.commits).toHaveLength(5)
    expect(page.nextSkip).toBe(5)

    const mergeCommit = page.commits.find((c) => c.oid === mergeOid)
    expect(mergeCommit).toBeDefined()
    expect(mergeCommit!.parents).toHaveLength(2)
    expect(mergeCommit!.parents[1]).toBe(featOid)
    expect(mergeCommit!.shortOid).toBe(mergeOid.slice(0, 7))
    // Current branch comes first, followed by remote ref and peeled annotated tag; origin/HEAD is omitted.
    expect(mergeCommit!.refs).toEqual([
      { name: 'main', kind: 'local', current: true },
      { name: 'origin/main', kind: 'remote', current: false },
      { name: 'v1.0.0', kind: 'tag', current: false },
    ])

    const rootCommit = page.commits.find((c) => c.oid === rootOid)
    expect(rootCommit).toBeDefined()
    expect(rootCommit!.parents).toEqual([])
    expect(rootCommit!.refs).toEqual([{ name: 'v0.1.0', kind: 'tag', current: false }])

    // Non-current local branch commit is included across branches.
    const sideCommit = page.commits.find((c) => c.subject === 'extra side branch commit')
    expect(sideCommit?.refs).toEqual([{ name: 'side/extra', kind: 'local', current: false }])
  })

  it('paginates cleanly with limit, skip, and exact hasMore detection', async () => {
    const first = await service.graph(repoDir, { limit: 2, skip: 0 })
    expect(first.commits).toHaveLength(2)
    expect(first.hasMore).toBe(true)
    expect(first.nextSkip).toBe(2)

    const second = await service.graph(repoDir, { limit: 2, skip: first.nextSkip })
    expect(second.commits).toHaveLength(2)
    expect(second.hasMore).toBe(true)
    expect(second.nextSkip).toBe(4)

    const third = await service.graph(repoDir, { limit: 2, skip: second.nextSkip })
    expect(third.commits).toHaveLength(1)
    expect(third.hasMore).toBe(false)
    expect(third.nextSkip).toBe(5)

    const allOids = [...first.commits, ...second.commits, ...third.commits].map((c) => c.oid)
    expect(new Set(allOids).size).toBe(5)

    // Exact boundary: limit equals total commits -> hasMore must be false.
    const exact = await service.graph(repoDir, { limit: 5, skip: 0 })
    expect(exact.commits).toHaveLength(5)
    expect(exact.hasMore).toBe(false)
  })

  it('detects detached HEAD and marks it as current ref', async () => {
    git(repoDir, 'checkout', '-q', '--detach', featOid)
    try {
      const page = await service.graph(repoDir, { limit: 20, skip: 0 })
      expect(page.currentBranch).toBeNull()
      expect(page.detached).toBe(true)
      expect(page.headOid).toBe(featOid)
      const featCommit = page.commits.find((c) => c.oid === featOid)
      expect(featCommit?.refs[0]).toEqual({ name: 'HEAD', kind: 'head', current: true })
      expect(featCommit?.refs.some((ref) => ref.name === 'feat/graph' && !ref.current)).toBe(true)
    } finally {
      git(repoDir, 'checkout', '-q', 'main')
    }
  })

  it('handles an empty repository with zero commits gracefully', async () => {
    const page = await service.graph(emptyRepoDir)
    expect(page).toEqual({
      commits: [],
      headOid: null,
      currentBranch: 'main',
      detached: false,
      hasMore: false,
      nextSkip: 0,
    })
  })

  it('rejects a directory that is not a git repository', async () => {
    await expect(service.graph(nonRepoDir)).rejects.toThrow()
  })

  it('reads commit details with parents and changed file diffs including root commits', async () => {
    const featDetails = await service.commit(repoDir, featOid)
    expect(featDetails.oid).toBe(featOid)
    expect(featDetails.parents).toEqual([rootOid])
    expect(featDetails.subject).toBe('add feature file')
    expect(featDetails.body).toBe('Detailed commit body here.')
    expect(featDetails.files).toEqual([
      { path: 'feature.txt', oldPath: null, status: 'added', insertions: 2, deletions: 0 },
    ])

    const mergeDetails = await service.commit(repoDir, mergeOid)
    expect(mergeDetails.parents).toHaveLength(2)

    const rootDetails = await service.commit(repoDir, rootOid)
    expect(rootDetails.parents).toEqual([])
    const rootDiff = await service.fileDiff(repoDir, 'readme.md', null, rootOid)
    expect(rootDiff).toEqual({
      path: 'readme.md',
      oldText: null,
      newText: 'hello\n',
      binary: false,
      tooLarge: false,
    })
  })
})
