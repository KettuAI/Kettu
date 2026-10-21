import type { FSWatcher } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { createSandbox, type Sandbox } from './test-support'
import { shouldIgnore, watchGitDir, type GitDirWatch, type WatchFn } from './watch'

let s: Sandbox
const open: GitDirWatch[] = []

beforeAll(async () => {
  s = await createSandbox()
})

afterAll(async () => {
  for (const watch of open) watch.close()
  await s.dispose()
})

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (condition()) return true
    await sleep(25)
  }
  return condition()
}

describe('shouldIgnore', () => {
  it.each([
    ['objects/ab/cdef0123', true],
    ['objects', true],
    ['logs/HEAD', true],
    ['logs/refs/heads/main', true],
    ['index.lock', true],
    ['refs/heads/main.lock', true],
    ['HEAD.lock', true],
    ['objects\\ab\\cdef', true],
    ['index', false],
    ['HEAD', false],
    ['FETCH_HEAD', false],
    ['refs/heads/main', false],
    ['refs/heads/objects', false],
    ['refs/heads/logs/x', false],
    ['rebase-merge/msgnum', false],
    ['', false],
    [null, false],
  ])('%j -> %s', (filename, ignored) => {
    expect(shouldIgnore(filename)).toBe(ignored)
  })
})

describe('watchGitDir', () => {
  it('reports a commit made with git', async () => {
    const dir = await s.initRepo('watched')
    await s.commit(dir, 'a.txt', 'chore: init')
    let changes = 0
    const watch = await watchGitDir({
      gitDir: join(dir, '.git'),
      commonDir: join(dir, '.git'),
      debounceMs: 100,
      onChange: () => changes++,
      onError: () => {},
    })
    open.push(watch)
    expect(watch.mode).toBe('recursive')
    await sleep(600) // let events from the setup above pass
    changes = 0
    await s.commit(dir, 'b.txt', 'feat: second')
    expect(await waitFor(() => changes > 0, 3000)).toBe(true)
    watch.close()
  })

  it('merges a burst of changes into one report', async () => {
    const dir = await s.initRepo('burst')
    await s.commit(dir, 'a.txt', 'chore: init')
    let changes = 0
    const watch = await watchGitDir({
      gitDir: join(dir, '.git'),
      commonDir: join(dir, '.git'),
      debounceMs: 800,
      onChange: () => changes++,
      onError: () => {},
    })
    open.push(watch)
    await sleep(1000)
    changes = 0
    await s.git(dir, 'tag', 't1')
    await s.git(dir, 'tag', 't2')
    await s.git(dir, 'tag', 't3')
    await sleep(2500)
    expect(changes).toBe(1)
    watch.close()
  })

  it('stays quiet after close', async () => {
    const dir = await s.initRepo('closed')
    await s.commit(dir, 'a.txt', 'chore: init')
    let changes = 0
    const watch = await watchGitDir({
      gitDir: join(dir, '.git'),
      commonDir: join(dir, '.git'),
      debounceMs: 50,
      onChange: () => changes++,
      onError: () => {},
    })
    watch.close()
    await sleep(100)
    changes = 0
    await s.commit(dir, 'b.txt', 'feat: second')
    await sleep(500)
    expect(changes).toBe(0)
  })

  it('falls back to non-recursive watches where recursion is unavailable', async () => {
    const dir = await s.initRepo('fallback')
    await s.commit(dir, 'a.txt', 'chore: init')
    const origin = await s.initBare('fallback-origin.git')
    await s.git(dir, 'remote', 'add', 'origin', origin)
    await s.git(dir, 'push', '-u', 'origin', 'main')

    const watched: { path: string; recursive: boolean }[] = []
    const real = (await import('node:fs')).watch
    const watch: WatchFn = (path, options, listener) => {
      if (options.recursive) throw new Error('recursive watching is not supported')
      watched.push({ path, recursive: false })
      return real(path, { persistent: false }, listener) as FSWatcher
    }
    const gitDir = join(dir, '.git')
    let changes = 0
    const handle = await watchGitDir({
      gitDir,
      commonDir: gitDir,
      debounceMs: 100,
      onChange: () => changes++,
      onError: () => {},
      watch,
    })
    open.push(handle)
    expect(handle.mode).toBe('fallback')
    expect(watched.map((w) => w.path)).toEqual([
      gitDir,
      join(gitDir, 'refs', 'heads'),
      join(gitDir, 'refs', 'remotes'),
      join(gitDir, 'refs', 'remotes', 'origin'),
    ])

    await sleep(600)
    changes = 0
    await s.commit(dir, 'b.txt', 'feat: second')
    expect(await waitFor(() => changes > 0, 3000)).toBe(true)
    handle.close()
  })

  it('reports a failing watcher and marks the watch as not alive', async () => {
    const dir = await s.initRepo('failing')
    const gitDir = join(dir, '.git')
    let listenerError: ((error: Error) => void) | undefined
    const stub = {
      on(event: string, callback: (error: Error) => void) {
        if (event === 'error') listenerError = callback
        return stub
      },
      close() {},
    } as unknown as FSWatcher
    const errors: Error[] = []
    let changes = 0
    const handle = await watchGitDir({
      gitDir,
      commonDir: gitDir,
      debounceMs: 20,
      onChange: () => changes++,
      onError: (error) => errors.push(error),
      watch: () => stub,
    })
    open.push(handle)
    expect(handle.alive).toBe(true)
    listenerError?.(new Error('EPERM'))
    expect(handle.alive).toBe(false)
    expect(errors.map((e) => e.message)).toEqual(['EPERM'])
    expect(await waitFor(() => changes > 0, 1000)).toBe(true)
    handle.close()
  })

  it('also watches the shared refs of a linked worktree', async () => {
    const dir = await s.initRepo('main-tree')
    await s.commit(dir, 'a.txt', 'chore: init')
    const tree = join(s.root, 'linked-tree')
    await s.git(dir, 'worktree', 'add', '-b', 'feat/linked', tree)
    const common = join(dir, '.git')
    const gitDir = await s.git(tree, 'rev-parse', '--absolute-git-dir')

    const paths: string[] = []
    const real = (await import('node:fs')).watch
    let changes = 0
    const handle = await watchGitDir({
      gitDir,
      commonDir: common,
      debounceMs: 100,
      onChange: () => changes++,
      onError: () => {},
      watch: (path, options, listener) => {
        paths.push(path)
        return real(path, options, listener) as FSWatcher
      },
    })
    open.push(handle)
    expect(paths).toEqual([gitDir, join(common, 'refs'), common])
    await sleep(600)
    changes = 0
    await s.commit(tree, 'b.txt', 'feat: in the worktree')
    expect(await waitFor(() => changes > 0, 3000)).toBe(true)
    handle.close()
  })
})
