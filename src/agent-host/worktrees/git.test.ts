import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Platform } from '@shared/platform'
import { createExec } from '../git/exec'
import type { WorktreeRecord } from '../storage'
import type { WorktreeGit } from './api'
import { createWorktreeGit } from './git'

const PLATFORM = process.platform as Platform
const ENV = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_NOSYSTEM: '1',
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: { ...process.env, ...ENV }, encoding: 'utf8' })
}

async function commit(cwd: string, file: string, text: string): Promise<void> {
  await writeFile(path.join(cwd, file), text)
  git(cwd, 'add', file)
  git(cwd, 'commit', '-q', '-m', `edit ${file}`)
}

async function isThere(target: string): Promise<boolean> {
  return stat(target).then(
    () => true,
    () => false,
  )
}

describe('createWorktreeGit', () => {
  const exec = createExec(() => ({ ...process.env, ...ENV })).exec
  let dir: string
  let project: string
  let worktrees: WorktreeGit
  const base = { root: null, base: 'main', template: 'kettu/{slug}' }

  beforeAll(async () => {
    dir = await realpath(await mkdtemp(path.join(tmpdir(), 'kettu-worktrees-')))
    project = path.join(dir, 'project')
    await mkdir(project)
    git(project, 'init', '-q', '-b', 'main')
    await commit(project, 'a.txt', 'a\n')
    git(dir, 'init', '-q', '--bare', 'origin.git')
    git(project, 'remote', 'add', 'origin', path.join(dir, 'origin.git'))
    git(project, 'push', '-q', '-u', 'origin', 'main')
    git(project, 'remote', 'set-head', 'origin', 'main')
    git(project, 'push', '-q', 'origin', 'main:refs/heads/kettu/taken-remote')
    git(project, 'fetch', '-q', 'origin')
    worktrees = createWorktreeGit({
      exec,
      platform: PLATFORM,
      homeDir: path.join(dir, 'home'),
      random: () => 'abcdef0123',
    })
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const create = (text: string, extra: Partial<Parameters<WorktreeGit['create']>[0]> = {}) =>
    worktrees.create({ projectPath: project, text, ...base, ...extra })

  it('creates branches and folders, moving past taken names', async () => {
    const first = await create('Fix the login button')
    expect(first.branch).toBe('kettu/fix-the-login-button')
    expect(path.dirname(first.path)).toBe(path.join(dir, 'project-worktrees'))
    expect(first.baseOid).toBe(git(project, 'rev-parse', 'main').trim())
    expect(git(first.path, 'branch', '--show-current').trim()).toBe(first.branch)

    const second = await create('Fix the login button', {
      takenByPullRequest: (name) => name === 'kettu/fix-the-login-button-2',
    })
    expect(second.branch).toBe('kettu/fix-the-login-button-3')
    expect((await create('taken remote')).branch).toBe('kettu/taken-remote-2')
    expect((await create('修复登录')).branch).toBe('kettu/session-abcdef')
    expect((await create('x', { branch: 'mine/feature' })).branch).toBe('mine/feature')
  })

  it('rejects bad names and bases', async () => {
    await expect(create('x', { base: 'nope' })).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(create('x', { base: '--all' })).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(create('x', { branch: '-f' })).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(create('x', { template: '{who}' })).rejects.toMatchObject({
      code: 'invalid_params',
    })
  })

  it('inspects and removes a clean worktree with its branch', async () => {
    const record = await create('clean one')
    const state = await worktrees.inspect(project, record)
    expect(state).toMatchObject({ exists: true, branchExists: true, uncommitted: 0, unpushed: 0 })
    expect(state.merged).toBe(true)
    expect(await worktrees.remove(project, record, { branch: 'delete', expected: state })).toEqual({
      branchDeleted: true,
    })
    expect(await isThere(record.path)).toBe(false)
    expect(git(project, 'branch', '--list', record.branch)).toBe('')
  })

  it('removes changed files only as they were shown, and never a locked worktree', async () => {
    const record = await create('dirty one')
    const clean = await worktrees.inspect(project, record)
    await writeFile(path.join(record.path, 'new.txt'), 'x')
    await writeFile(path.join(record.path, 'a.txt'), 'changed')
    await expect(
      worktrees.remove(project, record, { branch: 'keep', expected: clean }),
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(await isThere(path.join(record.path, 'new.txt'))).toBe(true)
    const dirty = await worktrees.inspect(project, record)
    expect(dirty.uncommitted).toBe(2)
    git(project, 'worktree', 'lock', record.path)
    await expect(
      worktrees.remove(project, record, { branch: 'keep', expected: dirty }),
    ).rejects.toMatchObject({ code: 'git_error' })
    expect(await isThere(path.join(record.path, 'new.txt'))).toBe(true)
    git(project, 'worktree', 'unlock', record.path)
    expect(await worktrees.remove(project, record, { branch: 'keep', expected: dirty })).toEqual({
      branchDeleted: false,
    })
    expect(await isThere(record.path)).toBe(false)
    expect(git(project, 'branch', '--list', record.branch)).not.toBe('')
  })

  it('counts unpushed commits and keeps an unmerged branch', async () => {
    const record = await create('unpushed one')
    await commit(record.path, 'b.txt', 'b\n')
    const state = await worktrees.inspect(project, record)
    expect(state).toMatchObject({ unpushed: 1, merged: false, uncommitted: 0 })
    git(record.path, 'push', '-q', 'origin', `${record.branch}:refs/heads/${record.branch}`)
    const pushed = await worktrees.inspect(project, record)
    expect(pushed.unpushed).toBe(0)
    expect(await worktrees.remove(project, record, { branch: 'delete', expected: pushed })).toEqual(
      { branchDeleted: false },
    )
    expect(await isThere(record.path)).toBe(false)
    expect(git(project, 'rev-parse', `refs/heads/${record.branch}`).trim()).toBe(pushed.head)

    await worktrees.recreate(project, record)
    expect(git(record.path, 'branch', '--show-current').trim()).toBe(record.branch)
    expect(await isThere(path.join(record.path, 'b.txt'))).toBe(true)
  })

  it('deletes a squash-merged branch', async () => {
    const record = await create('squashed one')
    await commit(record.path, 'c.txt', 'c\n')
    expect((await worktrees.inspect(project, record)).merged).toBe(false)
    git(project, 'merge', '--squash', '-q', record.branch)
    git(project, 'commit', '-q', '-m', 'squash')
    const state = await worktrees.inspect(project, record)
    expect(state.merged).toBe(true)
    // The squash made a new commit; the branch's own one is still on no remote.
    expect(state.unpushed).toBe(1)
    expect(await worktrees.remove(project, record, { branch: 'delete', expected: state })).toEqual({
      branchDeleted: true,
    })
    expect(git(project, 'branch', '--list', record.branch)).toBe('')
  })

  it('handles a folder deleted outside Kettu and a branch that is gone', async () => {
    const record: WorktreeRecord = await create('gone one')
    await rm(record.path, { recursive: true, force: true })
    const state = await worktrees.inspect(project, record)
    expect(state).toMatchObject({ exists: false, branchExists: true, uncommitted: 0 })
    expect(await worktrees.remove(project, record, { branch: 'keep', expected: state })).toEqual({
      branchDeleted: false,
    })
    git(project, 'branch', '-q', '-D', record.branch)
    await expect(worktrees.recreate(project, record)).rejects.toMatchObject({ code: 'not_found' })
  })

  describe('renaming a new branch', () => {
    const rename = (
      record: WorktreeRecord,
      slug: string,
      extra: Partial<Parameters<WorktreeGit['renameBranch']>[0]> = {},
    ) =>
      worktrees.renameBranch({
        projectPath: project,
        record,
        template: 'kettu/{slug}',
        slug,
        ...extra,
      })
    const current = (record: WorktreeRecord): string =>
      git(record.path, 'branch', '--show-current').trim()

    it('renames it with its worktree, keeping the folder', async () => {
      const record = await create('修复订阅里其他时区文章的日期')
      expect(record.branch).toMatch(/^kettu\/session-abcdef/)
      expect(await rename(record, 'Fix RSS feed timezones')).toBe('kettu/fix-rss-feed-timezones')
      expect(current(record)).toBe('kettu/fix-rss-feed-timezones')
      expect(git(project, 'branch', '--list', record.branch)).toBe('')
      expect(await isThere(record.path)).toBe(true)
      expect(git(project, 'worktree', 'list', '--porcelain')).toContain(
        'branch refs/heads/kettu/fix-rss-feed-timezones',
      )
    })

    it("fills the project's template", async () => {
      const record = await create('template one')
      const name = await rename(record, 'templated name', {
        template: '{type}/{issue}-{slug}',
        type: 'fix',
        issue: '12',
      })
      expect(name).toBe('fix/12-templated-name')
      expect(current(record)).toBe(name)
    })

    it('keeps only a slug of what the model wrote', async () => {
      const record = await create('hostile one')
      expect(await rename(record, '--force ../HEAD@{1} refs/heads/main')).toBe(
        'kettu/force-head-1-refs-heads-main',
      )
      expect(current(record)).toBe('kettu/force-head-1-refs-heads-main')
      const other = await create('nothing usable')
      for (const slug of ['', '修复登录', '---']) {
        expect(await rename(other, slug)).toBeNull()
        expect(current(other)).toBe(other.branch)
      }
    })

    it('moves past names taken locally, on a remote or by a pull request', async () => {
      git(project, 'branch', 'kettu/taken-local', 'main')
      const local = await create('local one')
      expect(await rename(local, 'taken local')).toBe('kettu/taken-local-2')
      git(project, 'push', '-q', 'origin', 'main:refs/heads/kettu/remote-only')
      git(project, 'fetch', '-q', 'origin')
      const remote = await create('remote one')
      expect(await rename(remote, 'remote only')).toBe('kettu/remote-only-2')
      const proposed = await create('proposed one')
      expect(
        await rename(proposed, 'proposed name', {
          takenByPullRequest: (name) => name === 'kettu/proposed-name',
        }),
      ).toBe('kettu/proposed-name-2')
    })

    it('keeps a name the model repeats, with or without a suffix', async () => {
      const record = await create('Repeat me')
      expect(await rename(record, 'repeat me')).toBeNull()
      const second = await create('Repeat me')
      expect(second.branch).toBe('kettu/repeat-me-2')
      expect(await rename(second, 'repeat me')).toBeNull()
      expect(current(second)).toBe('kettu/repeat-me-2')
    })

    it('never touches a branch that moved, was pushed or is proposed', async () => {
      const moved = await create('moved one')
      await commit(moved.path, 'moved.txt', 'x\n')
      expect(await rename(moved, 'new name')).toBeNull()
      expect(current(moved)).toBe(moved.branch)

      const upstream = await create('upstream one')
      git(upstream.path, 'push', '-q', '-u', 'origin', upstream.branch)
      git(project, 'update-ref', '-d', `refs/remotes/origin/${upstream.branch}`)
      expect(await rename(upstream, 'new name')).toBeNull()
      expect(current(upstream)).toBe(upstream.branch)

      const pushed = await create('pushed one')
      git(pushed.path, 'push', '-q', 'origin', pushed.branch)
      expect(await rename(pushed, 'new name')).toBeNull()
      expect(current(pushed)).toBe(pushed.branch)

      const proposed = await create('pull request one')
      expect(
        await rename(proposed, 'new name', {
          takenByPullRequest: (name) => name === proposed.branch,
        }),
      ).toBeNull()
      expect(current(proposed)).toBe(proposed.branch)

      expect(git(project, 'branch', '--list', 'kettu/new-name*')).toBe('')
    })

    it('never touches a branch its worktree left', async () => {
      const record = await create('switched one')
      git(record.path, 'switch', '-q', '-c', 'kettu/elsewhere')
      expect(await rename(record, 'new name')).toBeNull()
      expect(git(project, 'branch', '--list', record.branch)).not.toBe('')
      expect(current(record)).toBe('kettu/elsewhere')
    })
  })

  it('puts worktrees under the given root', async () => {
    const root = path.join(dir, 'chosen', 'root')
    const record = await create('rooted one', { root })
    expect(path.dirname(record.path)).toBe(root)
  })

  it.skipIf(PLATFORM === 'win32' || process.getuid?.() === 0)(
    'falls back to the home folder beside a read-only parent',
    async () => {
      const locked = path.join(dir, 'locked')
      await mkdir(path.join(locked, 'inner'), { recursive: true })
      await chmod(locked, 0o555)
      try {
        const root = await worktrees.rootFor(path.join(locked, 'inner'), null)
        expect(root).toMatch(
          new RegExp(`^${path.join(dir, 'home', '.kettu', 'worktrees', 'inner-')}[0-9a-f]{8}$`),
        )
      } finally {
        await chmod(locked, 0o755)
      }
    },
  )
})
