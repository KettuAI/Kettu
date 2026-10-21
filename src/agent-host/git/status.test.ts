import { mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { GitStatus } from '@shared/git'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CommandError } from './exec'
import { createRepoCache, emptyStatus, readStatus, type RepoCache } from './status'
import { createSandbox, type Sandbox } from './test-support'

let s: Sandbox
let counter = 0

beforeAll(async () => {
  s = await createSandbox()
})

afterAll(async () => {
  await s.dispose()
})

function status(dir: string, cache: RepoCache = createRepoCache()): Promise<GitStatus> {
  return readStatus({ projectPath: dir, exec: s.exec, cache, now: Date.now })
}

function name(prefix: string): string {
  return `${prefix}-${counter++}`
}

/** A work repository with one commit, pushed to a bare origin. */
async function publishedRepo(): Promise<{ work: string; origin: string }> {
  const origin = await s.initBare(name('origin') + '.git')
  const work = await s.initRepo(name('work'))
  await s.commit(work, 'readme.md', 'chore: init')
  await s.git(work, 'remote', 'add', 'origin', origin)
  await s.git(work, 'push', '-u', 'origin', 'main')
  return { work, origin }
}

/** main and topic diverge on f.txt; topic has two commits, the first of which conflicts. */
async function conflictingRepo(): Promise<string> {
  const dir = await s.initRepo(name('conflict'))
  await s.commit(dir, 'f.txt', 'chore: base', 'base\n')
  await s.git(dir, 'switch', '-c', 'topic')
  await s.commit(dir, 'f.txt', 'feat: topic change', 'topic\n')
  await s.commit(dir, 'g.txt', 'feat: topic file')
  await s.git(dir, 'switch', 'main')
  await s.commit(dir, 'f.txt', 'fix: main change', 'main\n')
  return dir
}

describe('a folder that is not a repository', () => {
  it('has no repo and empty fields', async () => {
    const dir = join(s.root, name('plain'))
    await mkdir(dir)
    const result = await status(dir)
    expect(result).toEqual({ ...emptyStatus(dir, result.updatedAt), updatedAt: result.updatedAt })
    expect(result.repo).toBeNull()
  })

  it('has no repo when the folder does not exist', async () => {
    const result = await status(join(s.root, 'does-not-exist'))
    expect(result.repo).toBeNull()
  })
})

describe('head and commits', () => {
  it('reports an unborn branch', async () => {
    const dir = await s.initRepo(name('unborn'))
    const result = await status(dir)
    expect(result.repo).toEqual({ root: dir, gitDir: join(dir, '.git') })
    expect(result.head).toEqual({ branch: null, oid: null, detached: false })
    expect(result.commits).toEqual([])
    expect(result.base).toBeNull()
  })

  it('reports an unborn branch with changes without running diff', async () => {
    const dir = await s.initRepo(name('unborn-changes'))
    await s.write(dir, 'a.txt', 'a\n')
    await s.git(dir, 'add', 'a.txt')
    const result = await status(dir)
    expect(result.changes).toMatchObject({ staged: 1, insertions: 0, deletions: 0 })
  })

  it('lists the commits of a repository without a remote, newest first', async () => {
    const dir = await s.initRepo(name('local'))
    const first = await s.commit(dir, 'a.txt', 'chore: first')
    const second = await s.commit(dir, 'b.txt', 'feat: second commit')
    const result = await status(dir)
    expect(result.head).toEqual({ branch: 'main', oid: second, detached: false })
    expect(result.upstream).toBeNull()
    expect(result.base).toBeNull()
    expect(result.remote).toBeNull()
    expect(result.operation).toBeNull()
    expect(result.lastFetchedAt).toBeNull()
    expect(result.stale).toBe(false)
    expect(result.commits.map((c) => [c.oid, c.subject, c.pushed])).toEqual([
      [second, 'feat: second commit', false],
      [first, 'chore: first', false],
    ])
    expect(Math.abs(result.commits[0]!.authoredAt - Date.now())).toBeLessThan(60_000)
  })

  it('keeps at most 20 commits', async () => {
    const dir = await s.initRepo(name('many'))
    for (let i = 0; i < 23; i++) await s.commit(dir, `f${i}.txt`, `chore: commit ${i}`)
    const result = await status(dir)
    expect(result.commits).toHaveLength(20)
    expect(result.commits[0]?.subject).toBe('chore: commit 22')
  })

  it('reports a detached head', async () => {
    const dir = await s.initRepo(name('detached'))
    const first = await s.commit(dir, 'a.txt', 'chore: first')
    await s.commit(dir, 'b.txt', 'chore: second')
    await s.git(dir, 'checkout', '--detach', first)
    const result = await status(dir)
    expect(result.head).toEqual({ branch: null, oid: first, detached: true })
  })

  it('finds the repository from a subfolder', async () => {
    const dir = await s.initRepo(name('sub'))
    await s.commit(dir, 'deep/er/a.txt', 'chore: first')
    const result = await status(join(dir, 'deep', 'er'))
    expect(result.repo?.root).toBe(dir)
  })
})

describe('changes', () => {
  it('counts staged, unstaged, untracked and conflicted entries and the diff size', async () => {
    const dir = await s.initRepo(name('changes'))
    await s.write(dir, 'a.txt', '1\n2\n3\n')
    await s.write(dir, 'b.txt', 'x\n')
    await s.write(dir, 'c.txt', 'y\n')
    await s.git(dir, 'add', '.')
    await s.git(dir, 'commit', '-m', 'chore: init')

    await s.write(dir, 'a.txt', '1\n2\n3\n4\n5\n') // unstaged: +2
    await s.write(dir, 'b.txt', 'changed\n') // staged: +1 -1
    await s.git(dir, 'add', 'b.txt')
    await s.git(dir, 'rm', '-q', 'c.txt') // staged delete: -1
    await s.write(dir, 'new.txt', 'n\n') // untracked
    await s.write(dir, 'dir/inner.txt', 'n\n') // untracked directory counts once

    const result = await status(dir)
    expect(result.changes).toEqual({
      staged: 2,
      unstaged: 1,
      untracked: 2,
      conflicted: 0,
      insertions: 3,
      deletions: 2,
    })
  })

  it('counts a rename once and does not read its old path as an entry', async () => {
    const dir = await s.initRepo(name('rename'))
    await s.commit(dir, 'old name.txt', 'chore: init', 'content\n'.repeat(5))
    await s.git(dir, 'mv', 'old name.txt', 'new name.txt')
    const result = await status(dir)
    expect(result.changes).toMatchObject({ staged: 1, unstaged: 0, untracked: 0, conflicted: 0 })
  })

  it('has no diff size when only untracked files exist', async () => {
    const dir = await s.initRepo(name('untracked'))
    await s.commit(dir, 'a.txt', 'chore: init')
    await s.write(dir, 'u.txt', 'u\n')
    const result = await status(dir)
    expect(result.changes).toMatchObject({ untracked: 1, insertions: 0, deletions: 0 })
  })
})

describe('upstream, base and pushed commits', () => {
  it('reports a published branch in sync', async () => {
    const { work, origin } = await publishedRepo()
    const result = await status(work)
    expect(result.upstream).toEqual({ name: 'origin/main', ahead: 0, behind: 0 })
    expect(result.remote).toEqual({ name: 'origin', url: origin, github: null })
    expect(result.base).toBeNull() // on the base branch itself
    expect(result.commits).toEqual([]) // nothing unpushed
  })

  it('lists the unpushed commits on the base branch', async () => {
    const { work } = await publishedRepo()
    const next = await s.commit(work, 'b.txt', 'feat: not pushed yet')
    const result = await status(work)
    expect(result.upstream).toEqual({ name: 'origin/main', ahead: 1, behind: 0 })
    expect(result.base).toBeNull()
    expect(result.commits.map((c) => [c.oid, c.pushed])).toEqual([[next, false]])
  })

  it("reports behind after a fetch of someone else's push", async () => {
    const { work, origin } = await publishedRepo()
    const other = join(s.root, name('other'))
    await s.git(s.root, 'clone', origin, other)
    await s.commit(other, 'theirs.txt', 'feat: theirs')
    await s.git(other, 'push')
    expect((await status(work)).upstream?.behind).toBe(0)
    await s.git(work, 'fetch', '--prune')
    const result = await status(work)
    expect(result.upstream).toEqual({ name: 'origin/main', ahead: 0, behind: 1 })
    expect(result.lastFetchedAt).not.toBeNull()
    expect(Math.abs(result.lastFetchedAt! - Date.now())).toBeLessThan(60_000)
  })

  it('compares a feature branch with the base and marks pushed commits', async () => {
    const { work } = await publishedRepo()
    await s.git(work, 'switch', '-c', 'feat/login')
    const one = await s.commit(work, 'one.txt', 'feat: one')
    await s.git(work, 'push', '-u', 'origin', 'feat/login')
    const two = await s.commit(work, 'two.txt', 'feat: two')
    const three = await s.commit(work, 'three.txt', 'feat: three')

    const result = await status(work)
    expect(result.head.branch).toBe('feat/login')
    expect(result.upstream).toEqual({ name: 'origin/feat/login', ahead: 2, behind: 0 })
    expect(result.base).toEqual({ name: 'origin/main', ahead: 3, behind: 0 })
    expect(result.commits.map((c) => [c.oid, c.pushed])).toEqual([
      [three, false],
      [two, false],
      [one, true],
    ])
  })

  it('counts commits the base gained since the branch started', async () => {
    const { work, origin } = await publishedRepo()
    await s.git(work, 'switch', '-c', 'feat/behind')
    await s.commit(work, 'f.txt', 'feat: mine')
    const other = join(s.root, name('other'))
    await s.git(s.root, 'clone', origin, other)
    await s.commit(other, 'x.txt', 'feat: x')
    await s.commit(other, 'y.txt', 'feat: y')
    await s.git(other, 'push')
    await s.git(work, 'fetch')
    const result = await status(work)
    expect(result.base).toEqual({ name: 'origin/main', ahead: 1, behind: 2 })
    expect(result.upstream).toBeNull()
    expect(result.commits.map((c) => [c.subject, c.pushed])).toEqual([['feat: mine', false]])
  })

  it("uses the remote's default branch as the base", async () => {
    const { work } = await publishedRepo()
    await s.git(work, 'switch', '-c', 'develop')
    await s.commit(work, 'd.txt', 'chore: develop')
    await s.git(work, 'push', '-u', 'origin', 'develop')
    await s.git(work, 'remote', 'set-head', 'origin', 'develop')
    await s.git(work, 'switch', '-c', 'feat/x')
    await s.commit(work, 'x.txt', 'feat: x')
    const result = await status(work)
    expect(result.base).toEqual({ name: 'origin/develop', ahead: 1, behind: 0 })
    expect(result.commits.map((c) => c.subject)).toEqual(['feat: x'])
  })

  it('falls back to a local main when there is no remote', async () => {
    const dir = await s.initRepo(name('nobase'))
    await s.commit(dir, 'a.txt', 'chore: init')
    await s.git(dir, 'switch', '-c', 'feat/y')
    await s.commit(dir, 'y.txt', 'feat: y')
    const result = await status(dir)
    expect(result.base).toEqual({ name: 'main', ahead: 1, behind: 0 })
    expect(result.commits.map((c) => c.subject)).toEqual(['feat: y'])
  })

  it('falls back to master', async () => {
    const dir = join(s.root, name('master'))
    await mkdir(dir)
    await s.git(dir, 'init', '-b', 'master')
    await s.commit(dir, 'a.txt', 'chore: init')
    await s.git(dir, 'switch', '-c', 'feat/z')
    await s.commit(dir, 'z.txt', 'feat: z')
    expect((await status(dir)).base).toEqual({ name: 'master', ahead: 1, behind: 0 })
  })

  it('has no base when neither main nor master exists and lists unpushed commits', async () => {
    const origin = await s.initBare(name('origin') + '.git')
    const dir = join(s.root, name('trunk'))
    await mkdir(dir)
    await s.git(dir, 'init', '-b', 'trunk')
    await s.commit(dir, 'a.txt', 'chore: init')
    await s.git(dir, 'remote', 'add', 'origin', origin)
    await s.git(dir, 'push', '-u', 'origin', 'trunk')
    const next = await s.commit(dir, 'b.txt', 'feat: b')
    const result = await status(dir)
    expect(result.base).toBeNull()
    expect(result.commits.map((c) => [c.oid, c.pushed])).toEqual([[next, false]])
  })

  it('treats an upstream whose branch was deleted as not published', async () => {
    const { work, origin } = await publishedRepo()
    await s.git(work, 'switch', '-c', 'feat/gone')
    await s.commit(work, 'g.txt', 'feat: g')
    await s.git(work, 'push', '-u', 'origin', 'feat/gone')
    await s.git(origin, 'branch', '-D', 'feat/gone')
    await s.git(work, 'fetch', '--prune')
    const result = await status(work)
    expect(result.upstream).toBeNull()
    expect(result.remote?.name).toBe('origin')
  })
})

describe('remote', () => {
  it('reads a GitHub remote', async () => {
    const dir = await s.initRepo(name('gh'))
    await s.commit(dir, 'a.txt', 'chore: init')
    await s.git(dir, 'remote', 'add', 'origin', 'git@github.com:acme/app.git')
    const result = await status(dir)
    expect(result.remote).toEqual({
      name: 'origin',
      url: 'git@github.com:acme/app.git',
      github: { owner: 'acme', repo: 'app' },
    })
  })

  it('leaves github empty for other hosts', async () => {
    const dir = await s.initRepo(name('gl'))
    await s.commit(dir, 'a.txt', 'chore: init')
    await s.git(dir, 'remote', 'add', 'origin', 'https://gitlab.com/acme/app.git')
    expect((await status(dir)).remote).toEqual({
      name: 'origin',
      url: 'https://gitlab.com/acme/app.git',
      github: null,
    })
  })

  it("prefers the upstream's remote over origin", async () => {
    const dir = await s.initRepo(name('two'))
    await s.commit(dir, 'a.txt', 'chore: init')
    await s.git(dir, 'remote', 'add', 'origin', 'https://github.com/me/app.git')
    await s.git(dir, 'remote', 'add', 'upstream', 'https://github.com/acme/app.git')
    await s.git(dir, 'config', 'branch.main.remote', 'upstream')
    await s.git(dir, 'config', 'branch.main.merge', 'refs/heads/main')
    expect((await status(dir)).remote).toMatchObject({
      name: 'upstream',
      github: { owner: 'acme', repo: 'app' },
    })
  })

  it('notices a changed remote URL', async () => {
    const dir = await s.initRepo(name('url'))
    await s.commit(dir, 'a.txt', 'chore: init')
    await s.git(dir, 'remote', 'add', 'origin', 'https://github.com/a/b.git')
    const cache = createRepoCache()
    expect((await status(dir, cache)).remote?.github).toEqual({ owner: 'a', repo: 'b' })
    await s.git(dir, 'remote', 'set-url', 'origin', 'https://github.com/acme/renamed-app.git')
    expect((await status(dir, cache)).remote?.github).toEqual({
      owner: 'acme',
      repo: 'renamed-app',
    })
  })
})

describe('operations', () => {
  it('reports a merge with conflicts', async () => {
    const dir = await conflictingRepo()
    await s.exec('git', ['merge', 'topic'], { cwd: dir, timeoutMs: 20_000 })
    const result = await status(dir)
    expect(result.operation).toEqual({ kind: 'merge' })
    expect(result.changes.conflicted).toBe(1)
  })

  it('reports the step of a rebase that stopped on a conflict', async () => {
    const dir = await conflictingRepo()
    await s.git(dir, 'switch', 'topic')
    await s.exec('git', ['rebase', 'main'], { cwd: dir, timeoutMs: 20_000 })
    const result = await status(dir)
    expect(result.operation).toEqual({ kind: 'rebase', step: [1, 2] })
    expect(result.head.detached).toBe(true)
    expect(result.changes.conflicted).toBe(1)
  })

  it('reports no operation once a rebase has finished', async () => {
    const dir = await conflictingRepo()
    await s.git(dir, 'switch', 'topic')
    await s.exec('git', ['rebase', 'main'], { cwd: dir, timeoutMs: 20_000 })
    await s.write(dir, 'f.txt', 'resolved\n')
    await s.git(dir, 'add', 'f.txt')
    await s.exec('git', ['-c', 'core.editor=true', 'rebase', '--continue'], {
      cwd: dir,
      timeoutMs: 20_000,
    })
    expect((await status(dir)).operation).toBeNull()
  })

  it('reports a cherry-pick with conflicts', async () => {
    const dir = await conflictingRepo()
    await s.exec('git', ['cherry-pick', 'topic~1'], { cwd: dir, timeoutMs: 20_000 })
    expect((await status(dir)).operation).toEqual({ kind: 'cherry-pick' })
  })

  it('reports a revert with conflicts', async () => {
    const dir = await s.initRepo(name('revert'))
    await s.commit(dir, 'f.txt', 'chore: base', 'base\n')
    const target = await s.commit(dir, 'f.txt', 'feat: x', 'x\n')
    await s.commit(dir, 'f.txt', 'feat: y', 'y\n')
    await s.exec('git', ['revert', '--no-edit', target], { cwd: dir, timeoutMs: 20_000 })
    expect((await status(dir)).operation).toEqual({ kind: 'revert' })
  })

  it('does not report the state of git am as an operation', async () => {
    const dir = await s.initRepo(name('am'))
    await s.commit(dir, 'f.txt', 'chore: base', 'base\n')
    await mkdir(join(dir, '.git', 'rebase-apply'))
    await s.write(dir, '.git/rebase-apply/applying', '')
    expect((await status(dir)).operation).toBeNull()
  })
})

describe('linked worktrees', () => {
  it('reads the branch and remote of a worktree and its own git dir', async () => {
    const { work, origin } = await publishedRepo()
    const tree = join(s.root, name('tree'))
    await s.git(work, 'worktree', 'add', '-b', 'feat/tree', tree)
    const next = await s.commit(tree, 'tree.txt', 'feat: in the worktree')
    const result = await status(tree)
    expect(result.repo?.root).toBe(await realpath(tree))
    expect(result.repo?.gitDir).toContain(join('.git', 'worktrees'))
    expect(result.head).toEqual({ branch: 'feat/tree', oid: next, detached: false })
    expect(result.remote?.url).toBe(origin)
    expect(result.base).toEqual({ name: 'origin/main', ahead: 1, behind: 0 })
  })
})

describe('failures', () => {
  it('throws when git cannot run', async () => {
    const dir = await s.initRepo(name('broken'))
    await s.commit(dir, 'a.txt', 'chore: init')
    const noGit = await readStatus({
      projectPath: dir,
      exec: async () => ({
        code: null,
        stdout: '',
        stderr: '',
        failure: 'not-found',
        message: 'spawn git ENOENT',
      }),
      cache: createRepoCache(),
      now: Date.now,
    }).catch((error: unknown) => error)
    expect(noGit).toBeInstanceOf(CommandError)
    expect((noGit as CommandError).result.failure).toBe('not-found')
  })

  it('does not treat a failing command other than a missing repository as a plain folder', async () => {
    const dir = await s.initRepo(name('dubious'))
    const error = await readStatus({
      projectPath: dir,
      exec: async () => ({
        code: 128,
        stdout: '',
        stderr: "fatal: detected dubious ownership in repository at '/x'",
        failure: null,
        message: '',
      }),
      cache: createRepoCache(),
      now: Date.now,
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CommandError)
  })
})
