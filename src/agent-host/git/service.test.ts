import { execFileSync } from 'node:child_process'
import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import type { GitStatus } from '@shared/git'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { GitServiceApi } from './api'
import type { Exec } from './exec'
import { findWindowsExecutable } from './executable'
import { createGitService, projectKey } from './service'
import { createTestService, result, sleep, waitFor } from './service-test-support'
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

async function repoWithCommit(): Promise<string> {
  const dir = await s.initRepo(name('repo'))
  await s.commit(dir, 'a.txt', 'chore: init')
  return dir
}

// The sandbox environment with a PATH that finds git but not gh: the other tests fake gh, and a
// real one can take longer than a test to answer, as on Windows runners.
async function envWithGitOnly(): Promise<NodeJS.ProcessEnv> {
  let bin: string
  if (process.platform === 'win32') {
    // Git for Windows' git.exe needs the files beside it, so it is not linked; gh is elsewhere.
    const git = await findWindowsExecutable('git', s.env)
    if (git === null) throw new Error('git was not found on PATH')
    bin = dirname(git)
  } else {
    bin = join(s.root, name('bin'))
    await mkdir(bin)
    await symlink(
      execFileSync('which', ['git'], { env: s.env }).toString().trim(),
      join(bin, 'git'),
    )
  }
  // Windows spells it Path, and a second spelling would leave the lookup to chance.
  const env = Object.entries(s.env).filter(([key]) => key.toUpperCase() !== 'PATH')
  return { ...Object.fromEntries(env), PATH: bin }
}

async function publishedRepo(): Promise<{ work: string; origin: string }> {
  const origin = await s.initBare(name('origin') + '.git')
  const work = await s.initRepo(name('work'))
  await s.commit(work, 'readme.md', 'chore: init')
  await s.git(work, 'remote', 'add', 'origin', origin)
  await s.git(work, 'push', '-u', 'origin', 'main')
  return { work, origin }
}

describe('projectKey', () => {
  it('normalizes absolute paths and folds case on Windows only', () => {
    expect(projectKey('/Work/App/', 'linux')).toBe('/Work/App')
    expect(projectKey('/Work/./App/../App', 'darwin')).toBe('/Work/App')
    expect(projectKey('C:\\Work\\App\\', 'win32')).toBe('c:\\work\\app')
    expect(projectKey('c:\\work\\APP', 'win32')).toBe('c:\\work\\app')
  })

  it('rejects relative paths', () => {
    expect(() => projectKey('work/app', 'linux')).toThrow(/absolute/)
    expect(() => projectKey('work\\app', 'win32')).toThrow(/absolute/)
  })
})

describe('status', () => {
  it('returns the status and remembers the branch', async () => {
    const dir = await repoWithCommit()
    const { svc } = createTestService(s, services)
    expect(svc.currentBranch(dir)).toBeNull()
    const status = await svc.status(dir)
    expect(status.repo?.root).toBe(dir)
    expect(status.head.branch).toBe('main')
    expect(svc.currentBranch(dir)).toBe('main')
  })

  it('rejects a relative project path', async () => {
    const { svc } = createTestService(s, services)
    await expect(svc.status('relative/path')).rejects.toThrow(/absolute/)
  })

  it('reports a folder that is not a repository', async () => {
    const dir = join(s.root, name('plain'))
    await mkdir(dir)
    const { svc } = createTestService(s, services)
    const status = await svc.status(dir)
    expect(status.repo).toBeNull()
    expect(status.stale).toBe(false)
    expect(svc.currentBranch(dir)).toBeNull()
  })

  it('runs at most one status process at a time and shares the follow-up', async () => {
    const dir = await repoWithCommit()
    const { svc, gitCalls } = createTestService(s, services)
    await svc.status(dir)
    const before = gitCalls.filter((call) => call[0] === 'status').length
    const results = await Promise.all(Array.from({ length: 8 }, () => svc.status(dir)))
    const runs = gitCalls.filter((call) => call[0] === 'status').length - before
    expect(runs).toBeLessThanOrEqual(2)
    expect(new Set(results.map((r) => r.updatedAt)).size).toBeLessThanOrEqual(2)
  })

  it('emits onChanged only when the status changed', async () => {
    const dir = await repoWithCommit()
    const { svc, statuses } = createTestService(s, services)
    await svc.status(dir)
    await svc.status(dir)
    await svc.status(dir)
    expect(statuses).toHaveLength(1)
    await s.write(dir, 'new.txt', 'x\n')
    await svc.status(dir)
    expect(statuses).toHaveLength(2)
    expect(statuses[1]?.changes.untracked).toBe(1)
  })

  it('keeps the last value and marks it stale when a refresh fails, then recovers', async () => {
    const dir = await repoWithCommit()
    let failing = false
    const base: Exec = s.exec
    const exec: Exec = async (file, args, options) =>
      failing && args[0] === 'status'
        ? result({ code: 128, stderr: 'fatal: unable to read the index' })
        : base(file, args, options)
    const logs: string[] = []
    const svc = createGitService({ env: s.env, log: (l, m) => logs.push(`${l}: ${m}`) }, { exec })
    services.push(svc)
    const good = await svc.status(dir)
    failing = true
    const stale = await svc.status(dir)
    expect(stale).toMatchObject({ stale: true, head: good.head, commits: good.commits })
    expect(logs.filter((line) => line.startsWith('warn'))).toHaveLength(1)
    await svc.status(dir)
    expect(logs.filter((line) => line.startsWith('warn'))).toHaveLength(1)
    failing = false
    expect((await svc.status(dir)).stale).toBe(false)
  })

  it('reports a missing git as no repository and in the tools', async () => {
    const dir = await repoWithCommit()
    const exec: Exec = async () =>
      result({ code: null, failure: 'not-found', message: 'spawn git ENOENT' })
    const logs: string[] = []
    const svc = createGitService({ env: s.env, log: (l, m) => logs.push(`${l}: ${m}`) }, { exec })
    services.push(svc)
    const status = await svc.status(dir)
    expect(status.repo).toBeNull()
    expect(status.stale).toBe(false)
    expect((await svc.tools()).git).toEqual({ found: false, version: null })
  })

  it('tells listeners when git turns out to be missing', async () => {
    const dir = await repoWithCommit()
    let missing = false
    const exec: Exec = async (file, args, options) => {
      if (file === 'gh') return result({ code: null, failure: 'not-found' })
      if (missing) return result({ code: null, failure: 'not-found' })
      return s.exec(file, args, options)
    }
    const svc = createGitService({ env: s.env, log: () => {} }, { exec })
    services.push(svc)
    const seen: boolean[] = []
    svc.onTools((tools) => seen.push(tools.git.found))
    expect((await svc.tools()).git.found).toBe(true)
    missing = true
    const status = await svc.status(dir)
    expect(status.repo).toBeNull()
    expect(seen).toEqual([false])
  })

  it('keeps one throwing listener from breaking the others', async () => {
    const dir = await repoWithCommit()
    const { svc, logs } = createTestService(s, services)
    const seen: GitStatus[] = []
    svc.onChanged(() => {
      throw new Error('listener bug')
    })
    svc.onChanged((status) => seen.push(status))
    await svc.status(dir)
    expect(seen).toHaveLength(1)
    expect(logs.some((line) => line.includes('listener bug'))).toBe(true)
  })
})

describe('retain and release', () => {
  it('refreshes at once and then follows a commit made with git', async () => {
    const dir = await repoWithCommit()
    const { svc, statuses } = createTestService(s, services)
    svc.retain(dir, 'port-1')
    expect(await waitFor(() => statuses.length === 1)).toBe(true)
    await sleep(800) // let the watcher settle
    const before = statuses.length
    const oid = await s.commit(dir, 'b.txt', 'feat: second')
    expect(await waitFor(() => statuses.length > before, 4000)).toBe(true)
    expect(statuses.at(-1)?.head.oid).toBe(oid)
  })

  it('follows a push and a fetch made outside the service', async () => {
    const { work, origin } = await publishedRepo()
    const { svc, statuses } = createTestService(s, services)
    svc.retain(work, 'port-1')
    expect(await waitFor(() => statuses.length === 1)).toBe(true)
    await sleep(800)
    await s.commit(work, 'b.txt', 'feat: ahead')
    expect(await waitFor(() => statuses.at(-1)?.upstream?.ahead === 1, 4000)).toBe(true)
    await s.git(work, 'push')
    expect(await waitFor(() => statuses.at(-1)?.upstream?.ahead === 0, 4000)).toBe(true)

    const other = join(s.root, name('other'))
    await s.git(s.root, 'clone', origin, other)
    await s.commit(other, 'c.txt', 'feat: theirs')
    await s.git(other, 'push')
    await s.git(work, 'fetch')
    expect(await waitFor(() => statuses.at(-1)?.upstream?.behind === 1, 4000)).toBe(true)
  })

  it('stops watching when the last subscriber releases', async () => {
    const dir = await repoWithCommit()
    const { svc, statuses } = createTestService(s, services)
    svc.retain(dir, 'a')
    svc.retain(dir, 'b')
    expect(await waitFor(() => statuses.length === 1)).toBe(true)
    await sleep(800)

    svc.release(dir, 'a')
    let before = statuses.length
    await s.commit(dir, 'b.txt', 'feat: still live')
    expect(await waitFor(() => statuses.length > before, 4000)).toBe(true)

    svc.release(dir, 'b')
    await sleep(300)
    before = statuses.length
    await s.commit(dir, 'c.txt', 'feat: no longer live')
    await sleep(1200)
    expect(statuses.length).toBe(before)
  })

  it('releases every project of a subscriber with releaseAll', async () => {
    const one = await repoWithCommit()
    const two = await repoWithCommit()
    const { svc, statuses } = createTestService(s, services)
    svc.retain(one, 'port')
    svc.retain(two, 'port')
    svc.retain(two, 'other-port')
    expect(await waitFor(() => statuses.length === 2)).toBe(true)
    await sleep(800)
    svc.releaseAll('port')
    await sleep(300)
    const before = statuses.length
    await s.commit(one, 'x.txt', 'feat: one')
    await s.commit(two, 'x.txt', 'feat: two')
    expect(await waitFor(() => statuses.length > before, 4000)).toBe(true)
    await sleep(800)
    expect(statuses.slice(before).every((status) => status.projectPath === two)).toBe(true)
  })

  it('ignores releasing what was never retained', async () => {
    const dir = await repoWithCommit()
    const { svc } = createTestService(s, services)
    expect(() => {
      svc.release(dir, 'nobody')
      svc.releaseAll('nobody')
      svc.release('/does/not/exist', 'nobody')
    }).not.toThrow()
  })

  it('logs instead of throwing for a relative path', () => {
    const { svc, logs } = createTestService(s, services)
    expect(() => svc.retain('relative', 'port')).not.toThrow()
    expect(logs[0]).toMatch(/absolute/)
  })
})

describe('fetch', () => {
  it('fetches, refreshes and returns the status', async () => {
    const { work, origin } = await publishedRepo()
    const other = join(s.root, name('other'))
    await s.git(s.root, 'clone', origin, other)
    await s.commit(other, 'c.txt', 'feat: theirs')
    await s.git(other, 'push')

    const { svc } = createTestService(s, services)
    expect((await svc.status(work)).upstream?.behind).toBe(0)
    const { status } = await svc.fetch(work)
    expect(status.upstream?.behind).toBe(1)
    expect(status.lastFetchedAt).not.toBeNull()
  })

  it('prunes deleted remote branches', async () => {
    const { work, origin } = await publishedRepo()
    await s.git(work, 'push', 'origin', 'main:refs/heads/gone')
    await s.git(work, 'fetch')
    await s.git(origin, 'branch', '-D', 'gone')
    const { svc } = createTestService(s, services)
    await svc.fetch(work)
    expect(await s.git(work, 'branch', '-r')).not.toContain('origin/gone')
  })

  it("rejects with git's message", async () => {
    const dir = await repoWithCommit()
    await s.git(dir, 'remote', 'add', 'origin', join(s.root, 'no-such-remote.git'))
    const { svc } = createTestService(s, services)
    await expect(svc.fetch(dir)).rejects.toThrow(
      /does not appear to be a git repository|not a git repository/i,
    )
  })

  it('shares one fetch between simultaneous requests', async () => {
    const { work } = await publishedRepo()
    const { svc, gitCalls } = createTestService(s, services)
    await Promise.all([svc.fetch(work), svc.fetch(work), svc.fetch(work)])
    expect(gitCalls.filter((call) => call[0] === 'fetch')).toHaveLength(1)
  })

  it('rejects a relative path', async () => {
    const { svc } = createTestService(s, services)
    await expect(svc.fetch('relative')).rejects.toThrow(/absolute/)
  })
})

describe('lifecycle', () => {
  it('refuses work after dispose and stops events', async () => {
    const dir = await repoWithCommit()
    const { svc, statuses } = createTestService(s, services)
    svc.retain(dir, 'port')
    expect(await waitFor(() => statuses.length === 1)).toBe(true)
    await svc.dispose()
    await expect(svc.status(dir)).rejects.toThrow(/disposed/)
    await expect(svc.pullRequest('https://github.com/a/b/pull/1')).rejects.toThrow(/disposed/)
    const before = statuses.length
    await s.commit(dir, 'b.txt', 'feat: after dispose')
    await sleep(800)
    expect(statuses.length).toBe(before)
  })

  it('uses the environment it was given and the one set later', async () => {
    const dir = await repoWithCommit()
    const logs: string[] = []
    const svc = createGitService({ env: { PATH: s.root }, log: (l, m) => logs.push(`${l}: ${m}`) })
    services.push(svc)
    expect((await svc.status(dir)).repo).toBeNull()
    expect((await svc.tools()).git.found).toBe(false)
    svc.setEnvironment(await envWithGitOnly())
    expect((await svc.reloadTools()).git.found).toBe(true)
    expect((await svc.status(dir)).repo?.root).toBe(dir)
  })
})

// A git that hangs on fetch shows that dispose ends running children. POSIX only: the
// stand-in is a shell script.
describe.skipIf(process.platform === 'win32')('with a git that hangs on fetch', () => {
  it('kills the fetch when the service is disposed', async () => {
    const bin = join(s.root, name('bin'))
    await mkdir(bin)
    const realGit = execFileSync('which', ['git'], { env: s.env }).toString().trim()
    await writeFile(
      join(bin, 'git'),
      '#!/bin/sh\nif [ "$1" = fetch ]; then exec sleep 30; fi\nexec "$REAL_GIT" "$@"\n',
    )
    await chmod(join(bin, 'git'), 0o755)
    const dir = await repoWithCommit()
    const svc = createGitService({
      env: { ...s.env, PATH: `${bin}${delimiter}${s.env.PATH ?? ''}`, REAL_GIT: realGit },
      log: () => {},
    })
    services.push(svc)
    const fetching = svc.fetch(dir).then(
      () => null,
      (error: unknown) => error,
    )
    await sleep(500)
    const started = Date.now()
    await svc.dispose()
    expect(await fetching).toBeInstanceOf(Error)
    expect(Date.now() - started).toBeLessThan(5000)
  })
})
