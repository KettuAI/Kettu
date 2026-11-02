import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { GitServiceApi } from './api'
import { expectOk } from './exec'
import { createTestService } from './service-test-support'
import { createSandbox, type Sandbox } from './test-support'

let s: Sandbox
let counter = 0
const services: GitServiceApi[] = []

beforeAll(async () => {
  s = await createSandbox()
})

afterEach(async () => {
  await Promise.all(services.splice(0).map((svc) => svc.dispose()))
})

afterAll(async () => {
  await s.dispose()
})

const name = (prefix: string): string => `${prefix}-${counter++}`
// A committer time, in seconds.
const T = 1_700_000_000

/** Commits a file with a fixed committer time, in seconds. */
async function commitAt(cwd: string, file: string, seconds: number): Promise<void> {
  await s.write(cwd, file, `${file}\n`)
  await s.git(cwd, 'add', '--', file)
  expectOk(
    'git commit',
    await s.exec('git', ['commit', '-m', `chore: ${file}`], {
      cwd,
      timeoutMs: 20_000,
      env: { GIT_COMMITTER_DATE: `@${seconds} +0000` },
    }),
  )
}

/** A clone of a local bare `origin`, on `main`, with one pushed commit. */
async function publishedRepo(): Promise<{ work: string; origin: string }> {
  const origin = await s.initBare(name('origin') + '.git')
  const work = await s.initRepo(name('work'))
  await s.commit(work, 'readme.md', 'chore: init')
  await s.git(work, 'remote', 'add', 'origin', origin)
  await s.git(work, 'push', '-u', 'origin', 'main')
  return { work, origin }
}

/** A repository whose files `names` are committed with their name as content. */
async function repoWith(...names: string[]): Promise<string> {
  const work = await s.initRepo(name('work'))
  for (const file of names) await s.write(work, file, `${file}\n`)
  await s.git(work, 'add', '--', ...names)
  await s.git(work, 'commit', '-m', 'chore: init')
  return work
}

/** A repository with `sub` added as a submodule of another local repository, not committed. */
async function repoWithSubmodule(): Promise<string> {
  const lib = await repoWith('lib.txt')
  const work = await repoWith('a.txt')
  await s.git(work, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'sub')
  return work
}

const read = (cwd: string, file: string): Promise<string> => readFile(join(cwd, file), 'utf8')

/** `git status --porcelain` as lines, for what a write left untouched. */
async function porcelain(cwd: string): Promise<string[]> {
  const args = ['status', '--porcelain', '--untracked-files=all']
  const result = expectOk('git status', await s.exec('git', args, { cwd, timeoutMs: 20_000 }))
  return result.stdout.split('\n').filter(Boolean)
}

describe('branches', () => {
  it('lists the local branches, newest first, and where else each is checked out', async () => {
    const work = await s.initRepo(name('branches'))
    await commitAt(work, 'a.txt', T + 1_000)
    await s.git(work, 'switch', '-c', 'feat/new')
    await commitAt(work, 'b.txt', T + 3_000)
    await s.git(work, 'switch', '-c', 'feat/mid', 'main')
    await commitAt(work, 'c.txt', T + 2_000)
    await s.git(work, 'switch', 'main')
    const other = join(s.root, name('worktree'))
    await s.git(work, 'worktree', 'add', other, 'feat/mid')
    const { svc } = createTestService(s, services)

    const list = await svc.branches(work)
    expect(list.branches).toEqual([
      { name: 'feat/new', committedAt: (T + 3_000) * 1000, current: false, worktree: null },
      {
        name: 'feat/mid',
        committedAt: (T + 2_000) * 1000,
        current: false,
        worktree: await realpath(other),
      },
      { name: 'main', committedAt: (T + 1_000) * 1000, current: true, worktree: null },
    ])
    expect(list.remotes).toEqual([])

    // From the other worktree, main is the one checked out elsewhere.
    expect((await svc.branches(other)).branches).toEqual([
      { name: 'feat/new', committedAt: (T + 3_000) * 1000, current: false, worktree: null },
      { name: 'feat/mid', committedAt: (T + 2_000) * 1000, current: true, worktree: null },
      {
        name: 'main',
        committedAt: (T + 1_000) * 1000,
        current: false,
        worktree: await realpath(work),
      },
    ])
  })

  it('lists an unborn current branch without a commit time', async () => {
    const work = await s.initRepo(name('unborn'))
    const { svc } = createTestService(s, services)
    expect(await svc.branches(work)).toEqual({
      branches: [{ name: 'main', committedAt: null, current: true, worktree: null }],
      remotes: [],
    })

    await commitAt(work, 'a.txt', T + 1_000)
    await s.git(work, 'switch', '--orphan', 'fresh')
    expect((await svc.branches(work)).branches).toEqual([
      { name: 'fresh', committedAt: null, current: true, worktree: null },
      { name: 'main', committedAt: (T + 1_000) * 1000, current: false, worktree: null },
    ])
  })

  it('marks no branch current on a detached HEAD', async () => {
    const work = await s.initRepo(name('detached'))
    await commitAt(work, 'a.txt', T + 1_000)
    await s.git(work, 'switch', '--detach')
    const { svc } = createTestService(s, services)
    expect((await svc.branches(work)).branches).toEqual([
      { name: 'main', committedAt: (T + 1_000) * 1000, current: false, worktree: null },
    ])
  })

  it('lists the remotes with their fetch URLs and GitHub repositories', async () => {
    const work = await s.initRepo(name('remotes'))
    await s.git(work, 'remote', 'add', 'origin', 'https://github.com/acme/app.git')
    await s.git(work, 'remote', 'add', 'mirror', 'git@gitlab.com:acme/app.git')
    const { svc } = createTestService(s, services)
    expect((await svc.branches(work)).remotes).toEqual([
      {
        name: 'origin',
        url: 'https://github.com/acme/app.git',
        github: { owner: 'acme', repo: 'app' },
      },
      { name: 'mirror', url: 'git@gitlab.com:acme/app.git', github: null },
    ])
  })

  it('rejects a folder that is not a repository', async () => {
    const folder = join(s.root, name('plain'))
    await mkdir(folder)
    const { svc } = createTestService(s, services)
    await expect(svc.branches(folder)).rejects.toThrow(/not a git repository/)
  })
})

describe('switchBranch', () => {
  it('switches to a local branch', async () => {
    const work = await repoWith('a.txt')
    await s.git(work, 'branch', 'feat')
    const { svc } = createTestService(s, services)
    const { status } = await svc.switchBranch(work, 'feat', false)
    expect(status.head.branch).toBe('feat')
  })

  it('creates a branch from HEAD and switches to it', async () => {
    const work = await repoWith('a.txt')
    const head = await s.git(work, 'rev-parse', 'HEAD')
    await s.write(work, 'a.txt', 'changed\n')
    const { svc } = createTestService(s, services)
    const { status, log } = await svc.switchBranch(work, 'feat/new', true)
    expect(status.head).toEqual({ branch: 'feat/new', oid: head, detached: false })
    expect(log).toContain("Switched to a new branch 'feat/new'")
    // Changes come along.
    expect(await read(work, 'a.txt')).toBe('changed\n')
  })

  it('never makes a local branch from a remote one of the same name', async () => {
    const { work, origin } = await publishedRepo()
    const other = join(s.root, name('other'))
    await s.git(s.root, 'clone', origin, other)
    await s.git(other, 'push', 'origin', 'main:remote-only')
    await s.git(work, 'fetch')
    const { svc } = createTestService(s, services)
    await expect(svc.switchBranch(work, 'remote-only', false)).rejects.toThrow(
      /invalid reference: remote-only/,
    )
    expect(await s.git(work, 'branch', '--list', 'remote-only')).toBe('')
    expect((await svc.status(work)).head.branch).toBe('main')
  })

  it("fails with git's message when local changes would be overwritten", async () => {
    const work = await repoWith('a.txt')
    await s.git(work, 'switch', '-c', 'other')
    await s.commit(work, 'a.txt', 'chore: other a', 'other\n')
    await s.git(work, 'switch', 'main')
    await s.write(work, 'a.txt', 'mine\n')
    const { svc } = createTestService(s, services)
    await expect(svc.switchBranch(work, 'other', false)).rejects.toThrow(/would be overwritten/)
    expect((await svc.status(work)).head.branch).toBe('main')
    expect(await read(work, 'a.txt')).toBe('mine\n')
  })

  it("fails with git's message for a branch checked out in another worktree", async () => {
    const work = await repoWith('a.txt')
    await s.git(work, 'branch', 'feat')
    await s.git(work, 'worktree', 'add', join(s.root, name('worktree')), 'feat')
    const { svc } = createTestService(s, services)
    await expect(svc.switchBranch(work, 'feat', false)).rejects.toThrow(/already used by worktree/)
  })

  it('refuses during a merge', async () => {
    const work = await repoWith('a.txt')
    await s.git(work, 'switch', '-c', 'other')
    await s.commit(work, 'a.txt', 'chore: theirs', 'theirs\n')
    await s.git(work, 'switch', 'main')
    await s.commit(work, 'a.txt', 'chore: ours', 'ours\n')
    await s.exec('git', ['merge', 'other'], { cwd: work, timeoutMs: 20_000 })
    const { svc } = createTestService(s, services)
    await expect(svc.switchBranch(work, 'other', false)).rejects.toThrow(/Finish the merge/)
  })
})

describe('publishBranch', () => {
  it('pushes the branch to the chosen remote and tracks it there', async () => {
    const { work, origin } = await publishedRepo()
    const fork = await s.initBare(name('fork') + '.git')
    await s.git(work, 'remote', 'add', 'fork', fork)
    await s.git(work, 'switch', '-c', 'feat/login')
    const oid = await s.commit(work, 'login.ts', 'feat: add login')
    const { svc } = createTestService(s, services)

    const { status } = await svc.publishBranch(work, 'fork')
    expect(status.upstream).toEqual({ name: 'fork/feat/login', ahead: 0, behind: 0 })
    expect(await s.git(fork, 'rev-parse', 'feat/login')).toBe(oid)
    expect(await s.git(origin, 'branch', '--list', 'feat/login')).toBe('')
  })

  it('refuses a branch that already tracks one', async () => {
    const { work } = await publishedRepo()
    const { svc } = createTestService(s, services)
    await expect(svc.publishBranch(work, 'origin')).rejects.toThrow(/already tracks origin\/main/)
  })

  it('refuses a remote the repository does not have', async () => {
    const { work } = await publishedRepo()
    await s.git(work, 'switch', '-c', 'feat')
    const { svc } = createTestService(s, services)
    await expect(svc.publishBranch(work, 'nope')).rejects.toThrow(/no remote named nope/)
    expect((await svc.status(work)).upstream).toBeNull()
  })
})

describe('commitChanges', () => {
  it('commits only the chosen files and leaves other changes as they were', async () => {
    const work = await repoWith('a.txt', 'b.txt', 'c.txt', 'd.txt')
    await s.write(work, 'a.txt', 'a2\n')
    await s.write(work, 'b.txt', 'b2\n')
    await s.git(work, 'add', 'b.txt')
    await s.write(work, 'b.txt', 'b3\n')
    await s.write(work, 'c.txt', 'c2\n')
    await s.git(work, 'add', 'c.txt')
    await s.write(work, 'd.txt', 'd2\n')
    const { svc } = createTestService(s, services)

    const { status, log } = await svc.commitChanges(work, 'feat: a and b', ['a.txt', 'b.txt'])
    expect(log).toContain('feat: a and b')
    expect(await s.git(work, 'show', '--format=%s', '--name-only', 'HEAD')).toBe(
      'feat: a and b\n\na.txt\nb.txt',
    )
    // The working tree's version of b, not the staged one.
    expect(await s.git(work, 'show', 'HEAD:b.txt')).toBe('b3')
    expect(await porcelain(work)).toEqual(['M  c.txt', ' M d.txt'])
    expect(status.changes).toMatchObject({ staged: 1, unstaged: 1 })
  })

  it('commits an untracked file, deletions and a rename', async () => {
    const work = await repoWith('gone.txt', 'staged-gone.txt', 'old.txt', 'keep.txt')
    await s.write(work, 'new dir/n.txt', 'n\n')
    await s.git(work, 'rm', '-q', 'staged-gone.txt')
    await s.git(work, 'mv', 'old.txt', 'renamed.txt')
    await rm(join(work, 'gone.txt'))
    await s.write(work, 'keep.txt', 'changed\n')
    const { svc } = createTestService(s, services)

    await svc.commitChanges(work, 'chore: tidy', [
      'new dir/n.txt',
      'gone.txt',
      'staged-gone.txt',
      'renamed.txt',
    ])
    expect(
      (await s.git(work, 'show', '--format=', '--name-status', '-M', 'HEAD')).split('\n'),
    ).toEqual([
      'D\tgone.txt',
      'A\tnew dir/n.txt',
      'R100\told.txt\trenamed.txt',
      'D\tstaged-gone.txt',
    ])
    expect(await porcelain(work)).toEqual([' M keep.txt'])
  })

  it('takes a rename by its old path too', async () => {
    const work = await repoWith('old.txt')
    await s.git(work, 'mv', 'old.txt', 'new.txt')
    const { svc } = createTestService(s, services)
    await svc.commitChanges(work, 'refactor: rename', ['old.txt'])
    expect(await s.git(work, 'show', '--format=', '--name-status', '-M', 'HEAD')).toBe(
      'R100\told.txt\tnew.txt',
    )
    expect(await porcelain(work)).toEqual([])
  })

  it('makes the first commit of a repository', async () => {
    const work = await s.initRepo(name('first'))
    await s.write(work, 'a.txt', 'a\n')
    await s.write(work, 'b.txt', 'b\n')
    const { svc } = createTestService(s, services)
    const { status } = await svc.commitChanges(work, 'chore: start', ['a.txt'])
    expect(status.head.oid).not.toBeNull()
    expect(await s.git(work, 'ls-tree', '--name-only', 'HEAD')).toBe('a.txt')
    expect(await porcelain(work)).toEqual(['?? b.txt'])
  })

  it('takes a message that starts with a dash as the message', async () => {
    const work = await repoWith('a.txt')
    const before = await s.git(work, 'rev-parse', 'HEAD')
    await s.write(work, 'a.txt', 'a2\n')
    const { svc } = createTestService(s, services)
    await svc.commitChanges(work, '--amend\n\n-n', ['a.txt'])
    expect(await s.git(work, 'log', '-1', '--format=%B')).toBe('--amend\n\n-n')
    expect(await s.git(work, 'rev-parse', 'HEAD~1')).toBe(before)
  })

  it.skipIf(process.platform === 'win32')(
    'treats paths literally, never as patterns or options',
    async () => {
      const work = await repoWith('a*.txt', 'ab.txt')
      await s.write(work, 'a*.txt', 'star\n')
      await s.write(work, 'ab.txt', 'ab2\n')
      await s.write(work, '-n.txt', 'dash\n')
      const { svc } = createTestService(s, services)
      await svc.commitChanges(work, 'chore: literal', ['a*.txt', '-n.txt'])
      expect(await s.git(work, 'show', '--format=', '--name-only', 'HEAD')).toBe('-n.txt\na*.txt')
      expect(await porcelain(work)).toEqual([' M ab.txt'])
    },
  )

  it('refuses a path that has no changes', async () => {
    const work = await repoWith('a.txt', 'b.txt')
    const before = await s.git(work, 'rev-parse', 'HEAD')
    await s.write(work, 'a.txt', 'a2\n')
    const { svc } = createTestService(s, services)
    await expect(svc.commitChanges(work, 'chore: x', ['a.txt', 'b.txt'])).rejects.toThrow(
      /b\.txt has no uncommitted changes/,
    )
    expect(await s.git(work, 'rev-parse', 'HEAD')).toBe(before)
    expect(await porcelain(work)).toEqual([' M a.txt'])
  })

  it('refuses during a merge', async () => {
    const work = await repoWith('a.txt', 'b.txt')
    await s.git(work, 'switch', '-c', 'other')
    await s.commit(work, 'a.txt', 'chore: theirs', 'theirs\n')
    await s.git(work, 'switch', 'main')
    await s.commit(work, 'a.txt', 'chore: ours', 'ours\n')
    await s.exec('git', ['merge', 'other'], { cwd: work, timeoutMs: 20_000 })
    await s.write(work, 'b.txt', 'b2\n')
    const { svc } = createTestService(s, services)
    await expect(svc.commitChanges(work, 'chore: b', ['b.txt'])).rejects.toThrow(/Finish the merge/)
  })

  it('refuses a submodule', async () => {
    const work = await repoWithSubmodule()
    await s.git(work, 'commit', '-q', '-m', 'chore: add sub')
    const before = await s.git(work, 'rev-parse', 'HEAD')
    await s.commit(join(work, 'sub'), 'lib.txt', 'chore: move sub', 'moved\n')
    const { svc } = createTestService(s, services)
    await expect(svc.commitChanges(work, 'chore: bump', ['sub'])).rejects.toThrow(
      /sub is a repository of its own/,
    )
    expect(await s.git(work, 'rev-parse', 'HEAD')).toBe(before)
  })

  it('leaves new files untracked when the commit fails', async () => {
    const work = await repoWith('a.txt')
    const before = await s.git(work, 'rev-parse', 'HEAD')
    await s.write(work, 'a.txt', 'a2\n')
    await s.write(work, 'new.txt', 'new\n')
    await s.write(
      work,
      '.git/hooks/pre-commit',
      '#!/bin/sh\necho "lint failed in new.txt" >&2\nexit 1\n',
    )
    await chmod(join(work, '.git/hooks/pre-commit'), 0o755)
    const { svc } = createTestService(s, services)
    await expect(svc.commitChanges(work, 'chore: x', ['a.txt', 'new.txt'])).rejects.toThrow(
      'lint failed in new.txt',
    )
    expect(await s.git(work, 'rev-parse', 'HEAD')).toBe(before)
    expect(await porcelain(work)).toEqual([' M a.txt', '?? new.txt'])
  })
})

describe('discardChanges', () => {
  it('puts modified and deleted files back and removes new ones', async () => {
    const work = await repoWith('mod.txt', 'staged.txt', 'gone.txt', 'staged-gone.txt', 'keep.txt')
    await s.write(work, 'mod.txt', 'changed\n')
    await s.write(work, 'staged.txt', 'staged\n')
    await s.git(work, 'add', 'staged.txt')
    await s.write(work, 'staged.txt', 'more\n')
    await s.git(work, 'rm', '-q', 'staged-gone.txt')
    await rm(join(work, 'gone.txt'))
    await s.write(work, 'new dir/untracked.txt', 'u\n')
    await s.write(work, 'added.txt', 'added\n')
    await s.git(work, 'add', 'added.txt')
    await s.write(work, 'added.txt', 'added more\n')
    await s.write(work, 'keep.txt', 'mine\n')
    const { svc } = createTestService(s, services)

    await svc.discardChanges(work, [
      'mod.txt',
      'staged.txt',
      'gone.txt',
      'staged-gone.txt',
      'new dir/untracked.txt',
      'added.txt',
    ])
    expect(await read(work, 'mod.txt')).toBe('mod.txt\n')
    expect(await read(work, 'staged.txt')).toBe('staged.txt\n')
    expect(await read(work, 'gone.txt')).toBe('gone.txt\n')
    expect(await read(work, 'staged-gone.txt')).toBe('staged-gone.txt\n')
    expect(existsSync(join(work, 'new dir/untracked.txt'))).toBe(false)
    expect(existsSync(join(work, 'added.txt'))).toBe(false)
    expect(await porcelain(work)).toEqual([' M keep.txt'])
  })

  it('undoes a rename and its edits', async () => {
    const work = await repoWith('old.txt')
    await s.git(work, 'mv', 'old.txt', 'new.txt')
    await s.write(work, 'new.txt', 'edited\n')
    const { svc } = createTestService(s, services)
    await svc.discardChanges(work, ['new.txt'])
    expect(await read(work, 'old.txt')).toBe('old.txt\n')
    expect(existsSync(join(work, 'new.txt'))).toBe(false)
    expect(await porcelain(work)).toEqual([])
  })

  it('refuses a path that has no changes', async () => {
    const work = await repoWith('a.txt')
    await s.write(work, 'a.txt', 'a2\n')
    const { svc } = createTestService(s, services)
    await expect(svc.discardChanges(work, ['a.txt', 'nope.txt'])).rejects.toThrow(
      /nope\.txt has no uncommitted changes/,
    )
    expect(await read(work, 'a.txt')).toBe('a2\n')
  })

  it('refuses while a file is conflicted', async () => {
    const work = await repoWith('a.txt', 'b.txt')
    await s.write(work, 'a.txt', 'stashed\n')
    await s.git(work, 'stash', 'push', '-q', '-m', 'test')
    await s.commit(work, 'a.txt', 'chore: ours', 'ours\n')
    await s.exec('git', ['stash', 'apply'], { cwd: work, timeoutMs: 20_000 })
    await s.write(work, 'b.txt', 'b2\n')
    const { svc } = createTestService(s, services)
    expect((await svc.status(work)).operation).toBeNull()
    await expect(svc.discardChanges(work, ['b.txt'])).rejects.toThrow(/Resolve the conflicts/)
    expect(await read(work, 'b.txt')).toBe('b2\n')
  })

  it('refuses a repository inside the working tree', async () => {
    const work = await repoWith('a.txt')
    const nested = join(work, 'nested')
    await mkdir(nested)
    await s.git(nested, 'init', '-q', '-b', 'main')
    await s.commit(nested, 'n.txt', 'chore: n')
    const { svc } = createTestService(s, services)
    await expect(svc.discardChanges(work, ['nested/'])).rejects.toThrow(/repository of its own/)
    expect(existsSync(join(nested, 'n.txt'))).toBe(true)
  })

  it('refuses a new submodule and leaves its working tree alone', async () => {
    const work = await repoWithSubmodule()
    await s.write(work, 'sub/lib.txt', 'edited\n')
    await s.write(work, 'sub/notes.txt', 'mine\n')
    const { svc } = createTestService(s, services)
    await expect(svc.discardChanges(work, ['sub'])).rejects.toThrow(
      /sub is a repository of its own/,
    )
    expect(await read(work, 'sub/lib.txt')).toBe('edited\n')
    expect(await read(work, 'sub/notes.txt')).toBe('mine\n')
    expect(await porcelain(work)).toEqual(['A  .gitmodules', 'AM sub'])
  })
})
