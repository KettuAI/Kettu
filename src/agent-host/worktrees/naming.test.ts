import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@shared/agent-host'
import type { SessionsFile } from '../storage'
import { startTestHost, type TestHost, type TestPort } from '../testing/harness'
import { tempFolder } from '../testing/temp'
import { BranchNaming, NAME_WAIT_MS } from './naming'

function later<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('BranchNaming', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('applies a name that comes in time, once', async () => {
    const slug = later<string | null>()
    const apply = vi.fn(async () => {})
    const naming = new BranchNaming(slug.promise)
    const first = naming.settle(apply)
    const second = naming.settle(apply)
    await vi.advanceTimersByTimeAsync(NAME_WAIT_MS - 1)
    slug.resolve('fix-rss-feed-timezones')
    await Promise.all([first, second])
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledWith('fix-rss-feed-timezones')
  })

  it('stops waiting after the limit and never applies a late name', async () => {
    const slug = later<string | null>()
    const apply = vi.fn(async () => {})
    const naming = new BranchNaming(slug.promise)
    let settled = false
    void naming.settle(apply).then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(NAME_WAIT_MS - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(true)
    slug.resolve('too-late')
    await naming.settle(apply)
    await vi.runAllTimersAsync()
    expect(apply).not.toHaveBeenCalled()
  })

  it('goes on at once when no name was written', async () => {
    const apply = vi.fn(async () => {})
    let settled = false
    void new BranchNaming(Promise.resolve(null)).settle(apply).then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(true)
    expect(apply).not.toHaveBeenCalled()
  })

  it('never applies a dropped name', async () => {
    const slug = later<string | null>()
    const apply = vi.fn(async () => {})
    const naming = new BranchNaming(slug.promise)
    const settling = naming.settle(apply)
    naming.drop()
    slug.resolve('fix-it')
    await settling
    expect(apply).not.toHaveBeenCalled()
  })
})

describe("a new session's worktree branch", () => {
  let host: TestHost | null = null

  afterEach(async () => {
    await host?.stop()
    host = null
  })

  async function start(): Promise<TestHost> {
    // A folder of the test's own, so the session index outlives the host.
    host = await startTestHost({ userDataPath: await tempFolder('kettu-host-') })
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
      GIT_CONFIG_NOSYSTEM: '1',
    }
    const git = (...args: string[]) => execFileSync('git', args, { cwd: host!.project, env })
    git('init', '-q', '-b', 'main')
    git('commit', '-q', '--allow-empty', '-m', 'init')
    return host
  }

  const branchOf = (folder: string): string =>
    execFileSync('git', ['branch', '--show-current'], { cwd: folder, encoding: 'utf8' }).trim()

  const summaries = (port: TestPort, sessionId: string): SessionSummary[] =>
    port.events.flatMap((event) =>
      event.type === 'session.summary' && event.summary.id === sessionId ? [event.summary] : [],
    )

  /** Waits for the first turn to have run and ended. */
  const firstTurnDone = (port: TestPort, sessionId: string): Promise<void> =>
    port.until(() => {
      const seen = summaries(port, sessionId)
      const running = seen.findIndex((summary) => summary.status === 'running')
      return running >= 0 && seen.slice(running).some((summary) => summary.status === 'ready')
    })

  it('takes the name the agent writes before the first message goes', async () => {
    const { project, dir } = await start()
    const window = host!.connect()
    const created = await window.request('sessions.create', {
      agentId: 'fake-agent',
      projectPath: project,
      prompt: [{ type: 'text', text: '修复订阅里其他时区文章的日期' }],
      worktree: { base: 'main' },
    })
    const folder = created.worktree!.path
    expect(created.worktree!.branch).toMatch(/^kettu\/session-[0-9a-f]{6}$/)
    await firstTurnDone(window, created.id)
    expect(window.summary(created.id)?.worktree?.branch).toBe('kettu/fake')
    expect(branchOf(folder)).toBe('kettu/fake')
    expect(window.summary(created.id)?.worktree?.path).toBe(folder)

    const seen = summaries(window, created.id)
    const renamed = seen.findIndex((summary) => summary.worktree?.branch === 'kettu/fake')
    const running = seen.findIndex((summary) => summary.status === 'running')
    expect(renamed).toBeGreaterThanOrEqual(0)
    expect(running).toBeGreaterThan(renamed)

    await host!.stop()
    host = null
    const index = JSON.parse(
      await readFile(path.join(dir, 'state', 'sessions.json'), 'utf8'),
    ) as SessionsFile
    const record = index.sessions.find((session) => session.id === created.id)
    expect(record?.worktree?.branch).toBe('kettu/fake')
  })

  it('keeps its first name when the agent writes none', async () => {
    const { project } = await start()
    const window = host!.connect()
    const created = await window.request('sessions.create', {
      agentId: 'fake-agent',
      projectPath: project,
      prompt: [{ type: 'text', text: 'fix the feed /garbage' }],
      worktree: { base: 'main' },
    })
    expect(created.worktree!.branch).toBe('kettu/fix-the-feed-garbage')
    await firstTurnDone(window, created.id)
    expect(window.summary(created.id)?.worktree?.branch).toBe('kettu/fix-the-feed-garbage')
    expect(branchOf(created.worktree!.path)).toBe('kettu/fix-the-feed-garbage')
  })
})
