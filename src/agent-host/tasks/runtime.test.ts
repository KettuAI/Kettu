import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_WORKTREE_SETTINGS } from '@shared/git'
import type { Platform } from '@shared/platform'
import { createExec } from '../git/exec'
import type { WorktreeRecord } from '../storage'
import { createWorktreeGit } from '../worktrees/git'
import { WorktreeManager } from '../worktrees/manager'
import type { TaskRecord, TaskRuntime } from './api'
import { createTaskRuntime, forkName } from './runtime'

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

function branches(cwd: string): string[] {
  return git(cwd, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').trim().split('\n')
}

describe('forkName', () => {
  it('keeps the label when the title is long', () => {
    expect(forkName('Add a dark mode', 'Write tests')).toBe('add a dark mode write tests')
    const long = forkName('Rework the whole settings page for every platform', 'Build')
    expect(long.endsWith(' build')).toBe(true)
    expect(long.replaceAll(' ', '-').length).toBeLessThanOrEqual(40)
    expect(forkName('Add a dark mode', '构建')).toBe('add a dark mode')
    expect(forkName('深色模式', 'Build')).toBe('build')
  })
})

describe('createTaskRuntime', () => {
  const exec = createExec(() => ({ ...process.env, ...ENV })).exec
  let dir: string
  let project: string
  let plain: string
  let rt: TaskRuntime
  const closed: string[] = []
  const removed: [string, boolean][] = []
  const logs: string[] = []

  const taskIn = (projectPath: string, title: string, worktree: WorktreeRecord | null = null) =>
    ({ id: 't-0123456789ab', title, projectPath, worktree }) as TaskRecord

  beforeAll(async () => {
    dir = await realpath(await mkdtemp(path.join(tmpdir(), 'kettu-task-runtime-')))
    project = path.join(dir, 'project')
    plain = path.join(dir, 'plain')
    await mkdir(project)
    await mkdir(plain)
    git(project, 'init', '-q', '-b', 'main')
    await writeFile(path.join(project, '.gitignore'), 'ignored/\n')
    git(project, 'add', '.gitignore')
    await commit(project, 'a.txt', 'one\ntwo\nthree\n')
    const manager = new WorktreeManager({
      git: createWorktreeGit({ exec, platform: PLATFORM, homeDir: path.join(dir, 'home') }),
      platform: PLATFORM,
      settings: () => ({ ...DEFAULT_WORKTREE_SETTINGS, branchTemplate: 'kettu/{slug}' }),
      root: () => null,
      env: async () => ({ ...process.env, ...ENV }),
      log: () => {},
    })
    rt = createTaskRuntime({
      sessions: {
        createNode: () => Promise.reject(new Error('unused')),
        prepareTaskWorktree: () => {},
        sendFromTool: () => Promise.reject(new Error('unused')),
        cancel: async () => {},
        has: () => false,
        isWorking: () => false,
        closeWorktreeUsers: async (target) => void closed.push(target),
        worktreeRemoved: (target, branchDeleted) => void removed.push([target, branchDeleted]),
      },
      agents: { statuses: () => [] },
      worktrees: manager,
      exec,
      library: { read: () => Promise.reject(new Error('unused')) },
      resolveProject: async (value) => value,
      attention: () => {},
      engine: () => null,
      log: (_level, message) => void logs.push(message),
    })
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('gives a project without git no worktree', async () => {
    expect(await rt.createWorktree(taskIn(plain, 'No git here'))).toBeNull()
    const empty = path.join(dir, 'empty')
    await mkdir(empty)
    git(empty, 'init', '-q', '-b', 'main')
    expect(await rt.createWorktree(taskIn(empty, 'No commit yet'))).toBeNull()
  })

  it('cuts the task from the default branch, or the branch checked out when there is none', async () => {
    const own = await rt.createWorktree(taskIn(project, 'Dark mode'))
    expect(own).toMatchObject({ branch: 'kettu/dark-mode', base: 'refs/heads/main' })
    const other = path.join(dir, 'trunk')
    await mkdir(other)
    git(other, 'init', '-q', '-b', 'trunk')
    await commit(other, 'a.txt', 'a\n')
    expect(await rt.createWorktree(taskIn(other, 'On trunk'))).toMatchObject({
      base: 'refs/heads/trunk',
    })
  })

  it('forks, merges and clears a branch of the task', async () => {
    const task = taskIn(project, 'Join work')
    const own = (await rt.createWorktree(task))!
    task.worktree = own
    await commit(own.path, 'base.txt', 'base\n')
    const left = await rt.forkWorktree(task, own, 'Build')
    const right = await rt.forkWorktree(task, own, 'Write tests')
    expect(left.branch).toBe('kettu/join-work-build')
    expect(right.branch).toBe('kettu/join-work-write-tests')
    expect(left.base).toBe(`refs/heads/${own.branch}`)
    expect(await isThere(path.join(left.path, 'base.txt'))).toBe(true)

    expect(await rt.clean(left)).toBe(true)
    await mkdir(path.join(left.path, 'ignored'))
    await writeFile(path.join(left.path, 'ignored', 'x'), 'x')
    expect(await rt.clean(left)).toBe(true)
    await writeFile(path.join(left.path, 'new.txt'), 'new\n')
    expect(await rt.clean(left)).toBe(false)
    git(left.path, 'add', 'new.txt')
    expect(await rt.clean(left)).toBe(false)
    git(left.path, 'commit', '-q', '-m', 'new')
    expect(await rt.clean(left)).toBe(true)
    await commit(right.path, 'tests.txt', 'tests\n')

    expect(await rt.merged(own, left)).toBe(false)
    expect(await rt.merge(own, left, true)).toBe('merged')
    expect(await rt.merge(own, right, true)).toBe('merged')
    expect(await rt.merged(own, left)).toBe(true)
    expect(await rt.merged(own, right)).toBe(true)
    expect(await rt.clean(own)).toBe(true)
    expect(await isThere(path.join(own.path, 'tests.txt'))).toBe(true)

    // A branch whose commits are on the task's branch goes with its worktree.
    await rt.removeWorktree(task, left, true)
    expect(await isThere(left.path)).toBe(false)
    expect(branches(project)).not.toContain(left.branch)
    expect(closed).toContain(left.path)
    expect(removed).toContainEqual([left.path, true])
    // One given up keeps its branch.
    await rt.removeWorktree(task, right, false)
    expect(await isThere(right.path)).toBe(false)
    expect(branches(project)).toContain(right.branch)
    expect(removed).toContainEqual([right.path, false])
    // The task's own worktree is never cleared.
    await rt.removeWorktree(task, own, true)
    expect(await isThere(own.path)).toBe(true)
  })

  it('stops on a conflict, leaving the merge or undoing it as asked', async () => {
    const task = taskIn(project, 'Conflict')
    const own = (await rt.createWorktree(task))!
    task.worktree = own
    const lane = await rt.forkWorktree(task, own, 'Build')
    await commit(own.path, 'a.txt', 'one\nours\nthree\n')
    await commit(lane.path, 'a.txt', 'one\ntheirs\nthree\n')

    expect(await rt.merge(own, lane, false)).toBe('conflict')
    expect(await rt.clean(own)).toBe(true)
    expect(await readFile(path.join(own.path, 'a.txt'), 'utf8')).toBe('one\nours\nthree\n')

    expect(await rt.merge(own, lane, true)).toBe('conflict')
    expect(await rt.clean(own)).toBe(false)
    expect(await rt.merged(own, lane)).toBe(false)
    await expect(rt.merge(own, lane, true)).rejects.toMatchObject({ code: 'conflict' })
    // Resolved and staged, the merge is still under way until it is committed.
    await writeFile(path.join(own.path, 'a.txt'), 'one\nboth\nthree\n')
    git(own.path, 'add', 'a.txt')
    expect(await rt.clean(own)).toBe(false)
    git(own.path, 'commit', '-q', '--no-edit')
    expect(await rt.clean(own)).toBe(true)
    expect(await rt.merged(own, lane)).toBe(true)
  })

  it('rejects a merge git cannot start and names why', async () => {
    const task = taskIn(project, 'Refused')
    const own = (await rt.createWorktree(task))!
    const lane = await rt.forkWorktree(task, own, 'Build')
    await commit(lane.path, 'a.txt', 'changed\n')
    await writeFile(path.join(own.path, 'a.txt'), 'uncommitted\n')
    await expect(rt.merge(own, lane, false)).rejects.toMatchObject({ code: 'git_error' })
    expect(await readFile(path.join(own.path, 'a.txt'), 'utf8')).toBe('uncommitted\n')
    await expect(rt.merge(own, { ...lane, branch: '--abort' }, false)).rejects.toMatchObject({
      code: 'invalid_params',
    })
    await expect(rt.merged(own, { ...lane, branch: 'kettu/none' })).rejects.toMatchObject({
      code: 'git_error',
    })
  })

  it('keeps what clearing a branch would lose', async () => {
    const task = taskIn(project, 'Keep work')
    const own = (await rt.createWorktree(task))!
    task.worktree = own
    const dirty = await rt.forkWorktree(task, own, 'Build')
    await writeFile(path.join(dirty.path, 'wip.txt'), 'wip\n')
    await rt.removeWorktree(task, dirty, false)
    expect(await isThere(path.join(dirty.path, 'wip.txt'))).toBe(true)
    expect(logs.some((line) => line.includes(dirty.path))).toBe(true)

    // Called merged with commits no other branch holds: the worktree goes, the branch stays.
    const alone = await rt.forkWorktree(task, own, 'Write tests')
    await commit(alone.path, 'only.txt', 'only\n')
    await rt.removeWorktree(task, alone, true)
    expect(await isThere(alone.path)).toBe(false)
    expect(branches(project)).toContain(alone.branch)
    // Gone already: nothing rejects.
    await expect(rt.removeWorktree(task, alone, true)).resolves.toBeUndefined()
  })
})
