import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import type { GitTools, PullRequest } from '@shared/git'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { GitServiceApi } from './api'
import type { Exec } from './exec'
import { createGitService } from './service'
import { createTestService, pullRequestJson, result, sleep, waitFor } from './service-test-support'
import { createSandbox, type Sandbox } from './test-support'

let s: Sandbox
let counter = 0
const services: GitServiceApi[] = []

beforeAll(async () => {
  s = await createSandbox()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(services.splice(0).map((svc) => svc.dispose()))
})

afterAll(async () => {
  await s.dispose()
})

const name = (prefix: string): string => `${prefix}-${counter++}`

/** A repository on branch feat/twelve whose origin is a GitHub URL, so gh is consulted. */
async function githubRepo(url = 'https://github.com/acme/app.git'): Promise<string> {
  const dir = await s.initRepo(name('gh'))
  await s.commit(dir, 'a.txt', 'chore: init')
  await s.git(dir, 'remote', 'add', 'origin', url)
  await s.git(dir, 'switch', '-c', 'feat/twelve')
  await s.commit(dir, 'f.txt', 'feat: twelve')
  return dir
}

describe('the current branch pull request', () => {
  it('loads the pull request when a project is retained and announces it', async () => {
    const dir = await githubRepo()
    const { svc, gh } = createTestService(s, services)
    gh.view = pullRequestJson()
    gh.list = [pullRequestJson()]
    const announced: [string, PullRequest | null][] = []
    let branchUpdates = 0
    svc.onPullRequest((projectPath, pr) => announced.push([projectPath, pr]))
    svc.onBranchPullRequests(() => branchUpdates++)

    svc.retain(dir, 'port')
    expect(await waitFor(() => announced.length === 1)).toBe(true)
    expect(announced[0]![0]).toBe(dir)
    expect(announced[0]![1]).toMatchObject({
      number: 12,
      owner: 'acme',
      repo: 'app',
      state: 'open',
      head: 'feat/twelve',
      review: 'review_required',
      mergeable: 'clean',
      checks: { state: 'passing', passed: 1 },
    })
    expect(await svc.currentPullRequest(dir)).toEqual(announced[0]![1])
    expect(await waitFor(() => branchUpdates === 1)).toBe(true)
    expect(svc.branchPullRequests(dir).get('feat/twelve')).toEqual({
      number: 12,
      state: 'open',
      url: 'https://github.com/acme/app/pull/12',
    })
    expect(
      gh
        .pullRequestCalls()
        .map((call) => call.slice(0, 2).join(' '))
        .sort(),
    ).toEqual(['pr list', 'pr view'])
  })

  it('announces nothing and knows no pull request when the branch has none', async () => {
    const dir = await githubRepo()
    const { svc, gh } = createTestService(s, services)
    const announced: (PullRequest | null)[] = []
    svc.onPullRequest((_path, pr) => announced.push(pr))
    svc.retain(dir, 'port')
    expect(await waitFor(() => gh.pullRequestCalls().length >= 2)).toBe(true)
    expect(await svc.currentPullRequest(dir)).toBeNull()
    expect(announced).toEqual([])
  })

  it('asks gh on demand for a project that is not retained', async () => {
    const dir = await githubRepo()
    const { svc, gh } = createTestService(s, services)
    gh.view = pullRequestJson()
    expect((await svc.currentPullRequest(dir))?.number).toBe(12)
    expect(await svc.currentPullRequest(dir)).not.toBeNull()
    expect(gh.pullRequestCalls().filter((call) => call[1] === 'view')).toHaveLength(1)
  })

  it('does not call gh for a remote that is not on GitHub', async () => {
    const dir = await githubRepo('https://gitlab.com/acme/app.git')
    const { svc, gh } = createTestService(s, services)
    svc.retain(dir, 'port')
    expect(await svc.currentPullRequest(dir)).toBeNull()
    await sleep(300)
    expect(gh.calls).toEqual([])
  })

  it('does not call gh without a remote', async () => {
    const dir = await s.initRepo(name('local'))
    await s.commit(dir, 'a.txt', 'chore: init')
    const { svc, gh } = createTestService(s, services)
    svc.retain(dir, 'port')
    expect(await svc.currentPullRequest(dir)).toBeNull()
    expect(gh.calls).toEqual([])
  })

  it('does not look for a pull request on a detached head', async () => {
    const dir = await githubRepo()
    await s.git(dir, 'checkout', '--detach')
    const { svc, gh } = createTestService(s, services)
    gh.view = pullRequestJson()
    svc.retain(dir, 'port')
    expect(await waitFor(() => gh.pullRequestCalls().some((call) => call[1] === 'list'))).toBe(true)
    expect(await svc.currentPullRequest(dir)).toBeNull()
    expect(gh.pullRequestCalls().some((call) => call[1] === 'view')).toBe(false)
  })

  it('keeps the last value when gh fails, and logs the failure once', async () => {
    const dir = await githubRepo()
    let clock = 1_000_000
    const { svc, gh, logs } = createTestService(s, services, { now: () => clock })
    gh.view = pullRequestJson()
    gh.list = [pullRequestJson()]
    const announced: (PullRequest | null)[] = []
    svc.onPullRequest((_path, pr) => announced.push(pr))
    svc.retain(dir, 'port')
    expect(await waitFor(() => announced.length === 1)).toBe(true)
    expect(await waitFor(() => svc.branchPullRequests(dir).size === 1)).toBe(true)

    gh.error = 'error connecting to api.github.com'
    for (let i = 0; i < 2; i++) {
      clock += 61_000
      const before = gh.pullRequestCalls().length
      await svc.status(dir)
      expect(await waitFor(() => gh.pullRequestCalls().length >= before + 2)).toBe(true)
    }
    await sleep(100)
    expect(announced).toHaveLength(1)
    expect((await svc.currentPullRequest(dir))?.number).toBe(12)
    expect(svc.branchPullRequests(dir).size).toBe(1)
    expect(logs.filter((line) => line.includes('gh pr view failed'))).toHaveLength(1)

    gh.error = null
    clock += 61_000
    await svc.status(dir)
    await sleep(300)
    expect(logs.filter((line) => line.startsWith('error'))).toEqual([])
  })

  it('clears the pull request while the new branch is looked up, then announces its own', async () => {
    const dir = await githubRepo()
    const { svc, gh } = createTestService(s, services)
    gh.view = pullRequestJson()
    const announced: (number | null)[] = []
    svc.onPullRequest((_path, pr) => announced.push(pr?.number ?? null))
    svc.retain(dir, 'port')
    expect(await waitFor(() => announced.length === 1)).toBe(true)
    await sleep(800)

    gh.view = pullRequestJson({
      url: 'https://github.com/acme/app/pull/13',
      headRefName: 'feat/other',
    })
    await s.git(dir, 'switch', '-c', 'feat/other')
    expect(await waitFor(() => announced.length === 3, 6000)).toBe(true)
    expect(announced).toEqual([12, null, 13])
  })

  it('looks again when a push lands', async () => {
    const origin = await s.initBare(name('origin') + '.git')
    const dir = await githubRepo()
    await s.git(dir, 'remote', 'set-url', '--push', 'origin', origin)
    await s.git(dir, 'push', '-u', 'origin', 'feat/twelve')
    await s.commit(dir, 'g.txt', 'feat: more')
    const { svc, gh } = createTestService(s, services)
    gh.view = pullRequestJson()
    svc.retain(dir, 'port')
    expect(await waitFor(() => gh.pullRequestCalls().length >= 2)).toBe(true)
    await waitFor(() => svc.currentBranch(dir) === 'feat/twelve')
    await sleep(800)
    const views = (): number => gh.pullRequestCalls().filter((call) => call[1] === 'view').length
    const before = views()
    await s.git(dir, 'push')
    expect(await waitFor(() => views() > before, 6000)).toBe(true)
  })

  it('limits refresh-driven lookups to one a minute', async () => {
    const dir = await githubRepo()
    let clock = 1_000_000
    const { svc, gh } = createTestService(s, services, { now: () => clock })
    svc.retain(dir, 'port')
    expect(await waitFor(() => gh.pullRequestCalls().length >= 2)).toBe(true)
    const calls = (): number => gh.pullRequestCalls().length

    await svc.status(dir)
    await svc.status(dir)
    clock += 30_000
    await svc.status(dir)
    await sleep(200)
    expect(calls()).toBe(2)

    clock += 31_000
    await svc.status(dir)
    expect(await waitFor(() => calls() === 4)).toBe(true)
  })

  it('polls every five minutes, and every minute while checks are pending', async () => {
    const dir = await githubRepo()
    const timeouts: { fn: () => void; delay: number }[] = []
    const real = globalThis.setTimeout
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, delay?: number) => {
      if ((delay ?? 0) >= 60_000) timeouts.push({ fn, delay: delay ?? 0 })
      return real(fn, delay)
    }) as typeof setTimeout)

    const { svc, gh } = createTestService(s, services)
    gh.view = pullRequestJson()
    svc.retain(dir, 'port')
    expect(await waitFor(() => timeouts.length === 1)).toBe(true)
    expect(timeouts[0]!.delay).toBe(300_000)

    gh.view = pullRequestJson({
      statusCheckRollup: [{ __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: null }],
    })
    timeouts[0]!.fn()
    expect(await waitFor(() => timeouts.length === 2)).toBe(true)
    expect(timeouts[1]!.delay).toBe(60_000)
    const before = gh.pullRequestCalls().length
    timeouts[1]!.fn()
    expect(await waitFor(() => gh.pullRequestCalls().length > before)).toBe(true)
  })

  it('stops polling when the project is released', async () => {
    const dir = await githubRepo()
    const cleared: unknown[] = []
    const realClear = globalThis.clearTimeout
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((
      timer: Parameters<typeof clearTimeout>[0],
    ) => {
      cleared.push(timer)
      return realClear(timer)
    }) as typeof clearTimeout)
    const { svc, gh } = createTestService(s, services)
    svc.retain(dir, 'port')
    expect(await waitFor(() => gh.pullRequestCalls().length >= 2)).toBe(true)
    await sleep(100)
    const before = cleared.length
    svc.release(dir, 'port')
    expect(cleared.length).toBeGreaterThan(before)
  })
})

describe('gh state', () => {
  it('does not ask for pull requests while signed out', async () => {
    const dir = await githubRepo()
    const { svc, gh } = createTestService(s, services)
    gh.signedIn = false
    svc.retain(dir, 'port')
    expect((await svc.tools()).gh).toEqual({
      state: 'signed-out',
      version: '2.98.0',
      account: null,
    })
    expect(await svc.currentPullRequest(dir)).toBeNull()
    expect(gh.pullRequestCalls()).toEqual([])
  })

  it('reports gh as not installed', async () => {
    const dir = await githubRepo()
    const { svc, gh } = createTestService(s, services)
    gh.installed = false
    svc.retain(dir, 'port')
    expect((await svc.tools()).gh).toEqual({ state: 'not-installed', version: null, account: null })
    expect(await svc.currentPullRequest(dir)).toBeNull()
  })

  it('reads versions and the account, and caches them until reloaded', async () => {
    const { svc, gh } = createTestService(s, services)
    const tools = await svc.tools()
    expect(tools.gh).toEqual({ state: 'ready', version: '2.98.0', account: 'octocat' })
    expect(tools.git.found).toBe(true)
    expect(tools.git.version).toMatch(/^\d+\.\d+/)
    await svc.tools()
    expect(gh.calls.filter((call) => call[0] === 'auth')).toHaveLength(1)
  })

  it('announces a change after reloading and starts looking for pull requests', async () => {
    const dir = await githubRepo()
    const { svc, gh } = createTestService(s, services)
    gh.signedIn = false
    svc.retain(dir, 'port')
    await svc.tools()
    const seen: GitTools['gh']['state'][] = []
    svc.onTools((tools) => seen.push(tools.gh.state))

    gh.signedIn = true
    gh.view = pullRequestJson()
    const announced: (PullRequest | null)[] = []
    svc.onPullRequest((_path, pr) => announced.push(pr))
    expect((await svc.reloadTools()).gh.state).toBe('ready')
    expect(seen).toEqual(['ready'])
    expect(await waitFor(() => announced.length === 1)).toBe(true)

    await svc.reloadTools()
    expect(seen).toEqual(['ready'])
  })
})

describe('pull request chips', () => {
  const url = 'https://github.com/acme/app/pull/12'

  it('loads details and caches them for a minute', async () => {
    let clock = 5_000_000
    const { svc, gh } = createTestService(s, services, { now: () => clock })
    gh.byUrl[url] = pullRequestJson()
    const first = await svc.pullRequest(url)
    expect(first).toMatchObject({ number: 12, owner: 'acme', repo: 'app', title: 'feat: twelve' })
    await svc.pullRequest(url)
    expect(gh.pullRequestCalls()).toHaveLength(1)
    expect(gh.pullRequestCalls()[0]!.slice(0, 3)).toEqual(['pr', 'view', url])

    clock += 61_000
    await svc.pullRequest(url)
    expect(gh.pullRequestCalls()).toHaveLength(2)
  })

  it('shares one lookup between simultaneous requests', async () => {
    const { svc, gh } = createTestService(s, services)
    gh.byUrl[url] = pullRequestJson()
    await Promise.all([svc.pullRequest(url), svc.pullRequest(url), svc.pullRequest(url)])
    expect(gh.pullRequestCalls()).toHaveLength(1)
  })

  it.each([
    'https://github.com/acme/app/issues/12',
    'https://github.com/acme/app/pull/12/files',
    'http://github.com/acme/app/pull/12',
    'https://example.com/acme/app/pull/12',
    '--help',
    '',
  ])('rejects %j without running gh', async (bad) => {
    const { svc, gh } = createTestService(s, services)
    await expect(svc.pullRequest(bad)).rejects.toThrow(/pull request URL/)
    expect(gh.calls).toEqual([])
  })

  it("rejects with gh's message when it cannot find the pull request", async () => {
    const { svc } = createTestService(s, services)
    await expect(svc.pullRequest(url)).rejects.toThrow(/Could not resolve/)
  })

  it('explains a missing or signed-out gh', async () => {
    const missing = createTestService(s, services)
    missing.gh.installed = false
    await expect(missing.svc.pullRequest(url)).rejects.toThrow(/not installed/)
    const signedOut = createTestService(s, services)
    signedOut.gh.signedIn = false
    await expect(signedOut.svc.pullRequest(url)).rejects.toThrow(/not signed in/)
  })

  it('does not cache a failure', async () => {
    const { svc, gh } = createTestService(s, services)
    await expect(svc.pullRequest(url)).rejects.toThrow()
    gh.byUrl[url] = pullRequestJson()
    expect((await svc.pullRequest(url)).number).toBe(12)
  })
})

describe("chip authors' avatars", () => {
  const login = 'overbench-builder[bot]'
  const avatar = 'https://avatars.githubusercontent.com/in/5463070?v=4'
  const apiCalls = (gh: { calls: string[][] }): string[][] =>
    gh.calls.filter((call) => call[0] === 'api')

  it('looks a login up once and keeps its avatar URL for the run', async () => {
    let clock = 5_000_000
    const { svc, gh } = createTestService(s, services, { now: () => clock })
    gh.users[login] = { login, avatar_url: avatar }
    expect(await svc.avatarUrl(login)).toBe(avatar)
    clock += 24 * 60 * 60_000
    expect(await svc.avatarUrl(login)).toBe(avatar)
    expect(apiCalls(gh)).toEqual([['api', '--hostname', 'github.com', `users/${login}`]])
  })

  it('shares one lookup between simultaneous requests', async () => {
    const { svc, gh } = createTestService(s, services)
    gh.users[login] = { login, avatar_url: avatar }
    await Promise.all([svc.avatarUrl(login), svc.avatarUrl(login), svc.avatarUrl(login)])
    expect(apiCalls(gh)).toHaveLength(1)
  })

  it("keeps null for a URL off GitHub's avatar host", async () => {
    const { svc, gh } = createTestService(s, services)
    gh.users.mirachen = { login: 'mirachen', avatar_url: 'https://example.com/a.png' }
    expect(await svc.avatarUrl('mirachen')).toBeNull()
    expect(await svc.avatarUrl('mirachen')).toBeNull()
    expect(apiCalls(gh)).toHaveLength(1)
  })

  it.each(['app/overbench-builder', '../user', 'users/x', '-h', 'a b', ''])(
    'rejects %j without running gh',
    async (bad) => {
      const { svc, gh } = createTestService(s, services)
      await expect(svc.avatarUrl(bad)).rejects.toThrow(/GitHub login/)
      expect(gh.calls).toEqual([])
    },
  )

  it('explains a missing or signed-out gh', async () => {
    const missing = createTestService(s, services)
    missing.gh.installed = false
    await expect(missing.svc.avatarUrl(login)).rejects.toThrow(/not installed/)
    const signedOut = createTestService(s, services)
    signedOut.gh.signedIn = false
    await expect(signedOut.svc.avatarUrl(login)).rejects.toThrow(/not signed in/)
    expect(apiCalls(signedOut.gh)).toEqual([])
  })

  it('does not keep a failure', async () => {
    const { svc, gh } = createTestService(s, services)
    await expect(svc.avatarUrl(login)).rejects.toThrow(/Not Found/)
    gh.users[login] = { login, avatar_url: avatar }
    expect(await svc.avatarUrl(login)).toBe(avatar)
  })
})

describe('background fetch', () => {
  it('fetches live projects with a remote every five minutes while enabled', async () => {
    const origin = await s.initBare(name('origin') + '.git')
    const dir = await s.initRepo(name('work'))
    await s.commit(dir, 'a.txt', 'chore: init')
    await s.git(dir, 'remote', 'add', 'origin', origin)
    const lonely = await s.initRepo(name('lonely'))
    await s.commit(lonely, 'a.txt', 'chore: init')

    const intervals: { fn: () => void; delay: number }[] = []
    const cleared: unknown[] = []
    const realSet = globalThis.setInterval
    const realClear = globalThis.clearInterval
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, delay?: number) => {
      intervals.push({ fn, delay: delay ?? 0 })
      return realSet(fn, 10_000_000)
    }) as typeof setInterval)
    vi.spyOn(globalThis, 'clearInterval').mockImplementation(((
      timer: Parameters<typeof clearInterval>[0],
    ) => {
      cleared.push(timer)
      return realClear(timer)
    }) as typeof clearInterval)

    const { svc, gitCalls, statuses } = createTestService(s, services)
    const fetches = (): number => gitCalls.filter((call) => call[0] === 'fetch').length
    svc.retain(dir, 'port')
    svc.retain(lonely, 'port')
    expect(await waitFor(() => statuses.length === 2)).toBe(true)

    svc.setBackgroundFetch(true)
    svc.setBackgroundFetch(true)
    expect(intervals).toHaveLength(1)
    expect(intervals[0]!.delay).toBe(300_000)
    expect(fetches()).toBe(0)

    intervals[0]!.fn()
    expect(await waitFor(() => fetches() === 1)).toBe(true)
    await sleep(300)
    expect(fetches()).toBe(1)
    expect(gitCalls.find((call) => call[0] === 'fetch')).toEqual(['fetch', '--prune'])

    svc.setBackgroundFetch(false)
    expect(cleared).toHaveLength(1)
  })

  it('logs a failed background fetch once and carries on', async () => {
    const dir = await s.initRepo(name('work'))
    await s.commit(dir, 'a.txt', 'chore: init')
    await s.git(dir, 'remote', 'add', 'origin', join(s.root, 'nowhere.git'))
    const intervals: (() => void)[] = []
    const realSet = globalThis.setInterval
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void) => {
      intervals.push(fn)
      return realSet(fn, 10_000_000)
    }) as typeof setInterval)
    const { svc, logs, statuses } = createTestService(s, services)
    svc.retain(dir, 'port')
    expect(await waitFor(() => statuses.length === 1)).toBe(true)
    svc.setBackgroundFetch(true)
    intervals[0]!()
    expect(await waitFor(() => logs.some((line) => line.includes('Background fetch failed')))).toBe(
      true,
    )
    intervals[0]!()
    await sleep(800)
    expect(logs.filter((line) => line.includes('Background fetch failed'))).toHaveLength(1)
  })
})

// A real script on PATH proves that the service finds gh through the environment it was
// given. Windows needs .cmd or .exe shims, which the injected-exec tests above cover.
describe.skipIf(process.platform === 'win32')('with a gh script on PATH', () => {
  it('runs the script from the given environment and maps its output', async () => {
    const bin = join(s.root, name('bin'))
    await mkdir(bin)
    const script = [
      '#!/bin/sh',
      'case "$1 $2" in',
      '  "--version "*) echo "gh version 9.9.9 (2030-01-01)" ;;',
      '  "auth status") echo "github.com"; echo "  Logged in to github.com account scripted (keyring)" ;;',
      `  "pr view") echo '${JSON.stringify(pullRequestJson({ number: 77, url: 'https://github.com/acme/app/pull/77' }))}' ;;`,
      `  "pr list") echo '[{"number":77,"state":"OPEN","isDraft":true,"url":"https://github.com/acme/app/pull/77","headRefName":"feat/twelve"}]' ;;`,
      '  *) echo "unexpected: $*" >&2; exit 2 ;;',
      'esac',
      '',
    ].join('\n')
    await writeFile(join(bin, 'gh'), script)
    await chmod(join(bin, 'gh'), 0o755)

    const dir = await githubRepo()
    const svc = createGitService({
      env: { ...s.env, PATH: `${bin}${delimiter}${s.env.PATH ?? ''}` },
      log: () => {},
    })
    services.push(svc)
    expect((await svc.tools()).gh).toEqual({
      state: 'ready',
      version: '9.9.9',
      account: 'scripted',
    })
    expect((await svc.currentPullRequest(dir))?.number).toBe(77)
    expect(svc.branchPullRequests(dir).get('feat/twelve')?.state).toBe('draft')
  })
})

describe('a gh answer the service cannot map', () => {
  it('is reported as a failure rather than thrown', async () => {
    const dir = await githubRepo()
    const logs: string[] = []
    const exec: Exec = async (file, args, options) => {
      if (file !== 'gh') return s.exec(file, args, options)
      if (args[0] === 'pr') return result({ stdout: '{"url": 1}' })
      return result({ stdout: 'gh version 2.98.0\nLogged in to github.com account a\n' })
    }
    const svc = createGitService({ env: s.env, log: (l, m) => logs.push(`${l}: ${m}`) }, { exec })
    services.push(svc)
    expect(await svc.currentPullRequest(dir)).toBeNull()
    expect(logs.some((line) => line.startsWith('warn') && line.includes('gh pr view failed'))).toBe(
      true,
    )
  })
})
