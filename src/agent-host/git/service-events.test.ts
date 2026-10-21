import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { GitEventDraft, GitServiceApi } from './api'
import { createTestService, pullRequestJson, sleep, waitFor } from './service-test-support'
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

async function publishedRepo(): Promise<{ work: string; origin: string }> {
  const origin = await s.initBare(name('origin') + '.git')
  const work = await s.initRepo(name('work'))
  await s.commit(work, 'readme.md', 'chore: init')
  await s.git(work, 'remote', 'add', 'origin', origin)
  await s.git(work, 'push', '-u', 'origin', 'main')
  return { work, origin }
}

/** A primed service plus a collector for the events it sends to sessions. */
async function setup(dir: string) {
  const test = createTestService(s, services)
  const events: { sessionId: string; events: GitEventDraft[] }[] = []
  test.svc.onSessionEvents((sessionId, drafts) => events.push({ sessionId, events: drafts }))
  await test.svc.status(dir)
  return { ...test, received: events }
}

describe('git events in a session', () => {
  it('reports a commit made during a tool call', async () => {
    const { work } = await publishedRepo()
    const { svc, received } = await setup(work)
    svc.toolCallStarted(work, 's1', 't1')
    const oid = await s.commit(work, 'b.txt', 'fix(auth): read the clock once')
    svc.toolCallEnded(work, 's1', 't1', 'execute', 'done')
    expect(await waitFor(() => received.length > 0)).toBe(true)
    expect(received).toEqual([
      {
        sessionId: 's1',
        events: [
          {
            kind: 'git',
            event: 'commit',
            commits: [{ oid, subject: 'fix(auth): read the clock once' }],
            more: 0,
          },
        ],
      },
    ])
  })

  it('lists three commits and counts the rest', async () => {
    const { work } = await publishedRepo()
    const { svc, received } = await setup(work)
    svc.toolCallStarted(work, 's1', 't1')
    for (let i = 1; i <= 5; i++) await s.commit(work, `f${i}.txt`, `chore: commit ${i}`)
    svc.toolCallEnded(work, 's1', 't1', 'execute', '')
    expect(await waitFor(() => received.length > 0)).toBe(true)
    const [event] = received[0]!.events
    expect(event).toMatchObject({ event: 'commit', more: 2 })
    expect(event?.event === 'commit' && event.commits.map((c) => c.subject)).toEqual([
      'chore: commit 5',
      'chore: commit 4',
      'chore: commit 3',
    ])
  })

  it('reports a commit and its push made in one tool call', async () => {
    const { work } = await publishedRepo()
    const { svc, received } = await setup(work)
    svc.toolCallStarted(work, 's1', 't1')
    await s.commit(work, 'b.txt', 'feat: ship it')
    await s.git(work, 'push')
    svc.toolCallEnded(work, 's1', 't1', 'execute', '')
    expect(await waitFor(() => received.length > 0)).toBe(true)
    expect(received[0]!.events.map((e) => e.event)).toEqual(['commit', 'push'])
    expect(received[0]!.events[1]).toEqual({
      kind: 'git',
      event: 'push',
      upstream: 'origin/main',
      count: 1,
    })
  })

  it('reports a push of earlier commits', async () => {
    const { work } = await publishedRepo()
    await s.commit(work, 'b.txt', 'feat: one')
    await s.commit(work, 'c.txt', 'feat: two')
    const { svc, received } = await setup(work)
    svc.toolCallStarted(work, 's1', 't1')
    await s.git(work, 'push')
    svc.toolCallEnded(work, 's1', 't1', 'execute', '')
    expect(await waitFor(() => received.length > 0)).toBe(true)
    expect(received[0]!.events).toEqual([
      { kind: 'git', event: 'push', upstream: 'origin/main', count: 2 },
    ])
  })

  it('reports a new branch with its first push', async () => {
    const { work } = await publishedRepo()
    const { svc, received } = await setup(work)
    svc.toolCallStarted(work, 's1', 't1')
    await s.git(work, 'switch', '-c', 'feat/new')
    await s.commit(work, 'b.txt', 'feat: new')
    await s.git(work, 'push', '-u', 'origin', 'feat/new')
    svc.toolCallEnded(work, 's1', 't1', 'execute', '')
    expect(await waitFor(() => received.length > 0)).toBe(true)
    expect(received[0]!.events.map((e) => e.event)).toEqual(['branch', 'commit', 'push'])
    expect(received[0]!.events[0]).toMatchObject({ branch: 'feat/new' })
    expect(received[0]!.events[2]).toMatchObject({ upstream: 'origin/feat/new', count: 1 })
  })

  it('reports a branch switch but no commits for commits that were already there', async () => {
    const { work } = await publishedRepo()
    await s.git(work, 'switch', '-c', 'feat/old')
    await s.commit(work, 'old.txt', 'feat: old work')
    await s.git(work, 'switch', 'main')
    // Commits made earlier than the call are not the call's doing.
    await sleep(1100)
    const { svc, received } = await setup(work)
    svc.toolCallStarted(work, 's1', 't1')
    await s.git(work, 'switch', 'feat/old')
    svc.toolCallEnded(work, 's1', 't1', 'execute', '')
    expect(await waitFor(() => received.length > 0)).toBe(true)
    expect(received[0]!.events).toEqual([{ kind: 'git', event: 'branch', branch: 'feat/old' }])
  })

  it('does not report commits that a pull brought in', async () => {
    const { work, origin } = await publishedRepo()
    const other = `${work}-other`
    await s.git(s.root, 'clone', origin, other)
    await s.commit(other, 'theirs.txt', 'feat: theirs')
    await s.git(other, 'push')
    await s.git(work, 'fetch')
    await sleep(1100)
    const { svc, received } = await setup(work)
    svc.toolCallStarted(work, 's1', 't1')
    await s.git(work, 'merge', '--ff-only', 'origin/main')
    svc.toolCallEnded(work, 's1', 't1', 'execute', '')
    await sleep(1000)
    expect(received).toEqual([])
    expect((await svc.status(work)).upstream?.behind).toBe(0)
  })

  it('reports the pull request URL that a command printed, once', async () => {
    const { work } = await publishedRepo()
    const { svc, received } = await setup(work)
    const output = 'Creating pull request\nhttps://github.com/acme/app/pull/57\n'
    svc.toolCallStarted(work, 's1', 't1')
    svc.toolCallEnded(work, 's1', 't1', 'execute', output)
    expect(await waitFor(() => received.length > 0)).toBe(true)
    expect(received[0]!.events).toEqual([
      { kind: 'git', event: 'pull_request', url: 'https://github.com/acme/app/pull/57' },
    ])
    svc.toolCallStarted(work, 's1', 't2')
    svc.toolCallEnded(work, 's1', 't2', 'execute', output)
    await sleep(500)
    expect(received).toHaveLength(1)
  })

  it('reports a pull request that appears for the branch after a push', async () => {
    const { work } = await publishedRepo()
    await s.git(work, 'remote', 'set-url', 'origin', 'https://github.com/acme/app.git')
    const origin = await s.initBare(name('push-target') + '.git')
    await s.git(work, 'remote', 'set-url', '--push', 'origin', origin)
    await s.git(work, 'switch', '-c', 'feat/twelve')
    await s.commit(work, 'f.txt', 'feat: twelve')

    const { svc, gh, received } = await setup(work)
    gh.view = null
    svc.retain(work, 'port')
    expect(await waitFor(() => gh.pullRequestCalls().length >= 2)).toBe(true)
    expect(await svc.currentPullRequest(work)).toBeNull()

    svc.toolCallStarted(work, 's1', 't1')
    await s.git(work, 'push', '-u', 'origin', 'feat/twelve')
    gh.view = pullRequestJson()
    svc.toolCallEnded(work, 's1', 't1', 'execute', 'pushed')
    expect(
      await waitFor(() => received.some((r) => r.events.some((e) => e.event === 'pull_request'))),
    ).toBe(true)
    const events = received.flatMap((r) => r.events)
    expect(events.map((e) => e.event)).toEqual(['push', 'pull_request'])
    expect(events[1]).toEqual({
      kind: 'git',
      event: 'pull_request',
      url: 'https://github.com/acme/app/pull/12',
    })
  })
})

describe('what is not attributed', () => {
  it('leaves a change unclaimed when two sessions had tool calls running', async () => {
    const { work } = await publishedRepo()
    const { svc, received, statuses } = await setup(work)
    svc.toolCallStarted(work, 's1', 't1')
    svc.toolCallStarted(work, 's2', 't2')
    await s.commit(work, 'b.txt', 'feat: whose is this')
    svc.toolCallEnded(work, 's1', 't1', 'execute', '')
    svc.toolCallEnded(work, 's2', 't2', 'execute', '')
    expect(await waitFor(() => statuses.at(-1)?.commits.length === 1)).toBe(true)
    await sleep(500)
    expect(received).toEqual([])
  })

  it('claims a change made after the other session finished', async () => {
    const { work } = await publishedRepo()
    const { svc, received } = await setup(work)
    svc.toolCallStarted(work, 's2', 't2')
    svc.toolCallEnded(work, 's2', 't2', 'read', '')
    svc.toolCallStarted(work, 's1', 't1')
    await s.commit(work, 'b.txt', 'feat: mine')
    svc.toolCallEnded(work, 's1', 't1', 'execute', '')
    expect(await waitFor(() => received.length > 0)).toBe(true)
    expect(received[0]!.sessionId).toBe('s1')
  })

  it('does not refresh or report for tools that cannot change the repository', async () => {
    const { work } = await publishedRepo()
    const { svc, received, gitCalls } = await setup(work)
    const before = gitCalls.filter((call) => call[0] === 'status').length
    for (const kind of ['read', 'search', 'think', 'fetch', 'switch_mode'] as const) {
      svc.toolCallStarted(work, 's1', kind)
      await s.commit(work, `${kind}.txt`, `chore: ${kind}`)
      svc.toolCallEnded(work, 's1', kind, kind, 'https://github.com/acme/app/pull/1')
    }
    await sleep(500)
    expect(gitCalls.filter((call) => call[0] === 'status').length).toBe(before)
    expect(received).toEqual([])
  })

  it('reports the change of parallel calls in one session once', async () => {
    const { work } = await publishedRepo()
    const { svc, received } = await setup(work)
    svc.toolCallStarted(work, 's1', 't1')
    svc.toolCallStarted(work, 's1', 't2')
    await s.commit(work, 'b.txt', 'feat: parallel')
    svc.toolCallEnded(work, 's1', 't1', 'execute', '')
    await sleep(300)
    svc.toolCallEnded(work, 's1', 't2', 'execute', '')
    await sleep(800)
    expect(received).toHaveLength(1)
    expect(received[0]!.events.map((e) => e.event)).toEqual(['commit'])
  })

  it('does not report the same commit for the next call', async () => {
    const { work } = await publishedRepo()
    const { svc, received } = await setup(work)
    svc.toolCallStarted(work, 's1', 't1')
    await s.commit(work, 'b.txt', 'feat: first')
    svc.toolCallEnded(work, 's1', 't1', 'execute', '')
    expect(await waitFor(() => received.length === 1)).toBe(true)
    svc.toolCallStarted(work, 's1', 't2')
    svc.toolCallEnded(work, 's1', 't2', 'execute', '')
    await sleep(500)
    expect(received).toHaveLength(1)
  })

  it('forgets the tool calls of a session when its turn ends', async () => {
    const { work } = await publishedRepo()
    const { svc, received } = await setup(work)
    svc.toolCallStarted(work, 's2', 'never-ends')
    svc.turnEnded(work, 's2')
    svc.toolCallStarted(work, 's1', 't1')
    await s.commit(work, 'b.txt', 'feat: mine')
    svc.toolCallEnded(work, 's1', 't1', 'execute', '')
    expect(await waitFor(() => received.length > 0)).toBe(true)
  })

  it('still reports when the service had no status at the start of the call', async () => {
    const { work } = await publishedRepo()
    const test = createTestService(s, services)
    const received: GitEventDraft[][] = []
    test.svc.onSessionEvents((_id, drafts) => received.push(drafts))
    test.svc.toolCallStarted(work, 's1', 't1')
    expect(await waitFor(() => test.svc.currentBranch(work) === 'main')).toBe(true)
    await s.commit(work, 'b.txt', 'feat: late start')
    test.svc.toolCallEnded(work, 's1', 't1', 'execute', '')
    expect(await waitFor(() => received.length > 0)).toBe(true)
  })

  it('ignores the end of a call it never saw start', async () => {
    const { work } = await publishedRepo()
    const { svc, received } = await setup(work)
    await s.commit(work, 'b.txt', 'feat: unseen')
    svc.toolCallEnded(work, 's1', 'unknown', 'execute', 'https://github.com/acme/app/pull/3')
    await sleep(600)
    expect(received).toEqual([])
  })
})

describe('turn end', () => {
  it('refreshes the status', async () => {
    const { work } = await publishedRepo()
    const { svc, statuses } = await setup(work)
    await s.commit(work, 'b.txt', 'feat: before the turn ended')
    const before = statuses.length
    svc.turnEnded(work, 's1')
    expect(await waitFor(() => statuses.length > before)).toBe(true)
    expect(statuses.at(-1)?.upstream?.ahead).toBe(1)
  })

  it('does nothing for a project it does not know', () => {
    const { svc } = createTestService(s, services)
    expect(() => {
      svc.turnEnded('/not/known', 's1')
      svc.toolCallEnded('/not/known', 's1', 't', 'execute', '')
    }).not.toThrow()
  })
})
