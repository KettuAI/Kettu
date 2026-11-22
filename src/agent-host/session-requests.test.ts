import { afterEach, expect, it } from 'vitest'
import { startTestHost, type TestHost, type TestPort } from './testing/harness'
import { tempFolder } from './testing/temp'

const hosts: TestHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
})

async function readySession(): Promise<{ window: TestPort; id: string }> {
  const host = await startTestHost()
  hosts.push(host)
  const window = host.connect()
  const { id } = await window.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: host.project,
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')
  return { window, id }
}

it('reads only what waits for an answer, as many as the summary counts', async () => {
  const { window, id } = await readySession()
  expect(await window.request('sessions.requests', { sessionId: id })).toEqual({
    entries: [],
    askedAt: {},
    suggestions: [],
  })
  await window.request('sessions.prompt', {
    sessionId: id,
    content: [{ type: 'text', text: '/parallel-permissions' }],
  })
  await window.until(() => window.summary(id)?.permissionCount === 3)

  const { entries } = await window.request('sessions.requests', { sessionId: id })
  expect(entries.map((entry) => (entry.kind === 'tool' ? entry.title : entry.kind))).toEqual([
    'Run pnpm lint --fix',
    'Edit package.json',
    'Delete .cache',
  ])
  for (const entry of entries) expect(entry).toMatchObject({ kind: 'tool', permission: {} })
})

it("carries the latest plan's progress in the session's summary", async () => {
  const { window, id } = await readySession()
  expect(window.summary(id)?.plan).toBeNull()
  await window.request('sessions.prompt', {
    sessionId: id,
    content: [{ type: 'text', text: '/plan --step 300' }],
  })
  await window.until(() => window.summary(id)?.plan?.done === 1)
  expect(window.summary(id)?.plan).toEqual({
    done: 1,
    total: 4,
    current: { index: 1, text: 'Find the second clock read' },
  })
  await window.until(
    () => window.summary(id)?.plan?.done === 4 && window.summary(id)?.status === 'ready',
  )
  expect(window.summary(id)?.plan).toEqual({ done: 4, total: 4, current: null })
})

it("carries the running turn's start in the session's summary", async () => {
  const { window, id } = await readySession()
  expect(window.summary(id)?.turnStartedAt).toBeNull()
  const before = Date.now()
  await window.request('sessions.prompt', {
    sessionId: id,
    content: [{ type: 'text', text: '/plan --step 300' }],
  })
  await window.until(() => window.summary(id)?.status === 'running')
  const started = window.summary(id)?.turnStartedAt
  expect(started).toBeGreaterThanOrEqual(before)
  expect(started).toBeLessThanOrEqual(Date.now())
  await window.until(() => window.summary(id)?.status === 'ready')
  expect(window.summary(id)?.turnStartedAt).toBeNull()
})

it('says when each request began to wait', async () => {
  const { window, id } = await readySession()
  const before = Date.now()
  await window.request('sessions.prompt', {
    sessionId: id,
    content: [{ type: 'text', text: '/parallel-permissions' }],
  })
  await window.until(() => window.summary(id)?.permissionCount === 3)

  const { entries, askedAt } = await window.request('sessions.requests', { sessionId: id })
  expect(Object.keys(askedAt ?? {}).sort()).toEqual(entries.map((entry) => entry.id).sort())
  for (const at of Object.values(askedAt ?? {})) {
    expect(at).toBeGreaterThanOrEqual(before)
    expect(at).toBeLessThanOrEqual(Date.now())
  }
})

it("carries the tool the running turn calls in the session's summary", async () => {
  const { window, id } = await readySession()
  expect(window.summary(id)?.activity).toBeNull()
  const before = Date.now()
  await window.request('sessions.prompt', {
    sessionId: id,
    content: [{ type: 'text', text: '/permission' }],
  })
  await window.until(() => window.summary(id)?.permissionCount === 1)
  const activity = window.summary(id)?.activity
  expect(activity).toMatchObject({
    toolKind: 'execute',
    title: 'Run pnpm test --filter login',
    detail: 'pnpm test --filter login',
  })
  expect(activity?.startedAt).toBeGreaterThanOrEqual(before)

  const { entries } = await window.request('sessions.requests', { sessionId: id })
  const entry = entries[0]
  expect(entry?.kind === 'tool' && entry.id).toBe(activity?.entryId)
  if (entry?.kind !== 'tool' || !entry.permission) throw new Error('No request')
  await window.request('permissions.respond', {
    sessionId: id,
    requestId: entry.permission.requestId,
    optionId: 'reject-once',
  })
  await window.until(() => window.summary(id)?.status === 'ready')
  expect(window.summary(id)?.activity).toBeNull()
})

it("says in the session's summary how its last turn ended", async () => {
  const { window, id } = await readySession()
  expect(window.summary(id)?.lastTurn).toBeNull()
  const say = async (text: string) => {
    await window.request('sessions.prompt', { sessionId: id, content: [{ type: 'text', text }] })
    await window.until(() => window.summary(id)?.status === 'running')
  }

  const before = Date.now()
  await say('/plan --step 50')
  // A running turn has no ending yet.
  expect(window.summary(id)?.lastTurn).toBeNull()
  await window.untilStatus(id, 'ready')
  const ended = window.summary(id)?.lastTurn
  expect(ended).toEqual({ reason: 'end_turn', endedAt: expect.any(Number) })
  expect(ended?.endedAt).toBeGreaterThanOrEqual(before)

  await say('/error --hold 100')
  expect(window.summary(id)?.lastTurn).toBeNull()
  await window.until(() => window.summary(id)?.lastTurn?.reason === 'failed')
  expect(window.summary(id)?.lastTurn).toEqual({
    reason: 'failed',
    endedAt: expect.any(Number),
    error: 'Internal error: The fake agent failed this turn on purpose',
  })

  await say('/cancel')
  expect(window.summary(id)?.lastTurn).toBeNull()
  await window.request('sessions.cancel', { sessionId: id })
  await window.until(() => window.summary(id)?.lastTurn?.reason === 'cancelled')
  expect(window.summary(id)?.lastTurn).toEqual({ reason: 'cancelled', endedAt: expect.any(Number) })
})

it('names the window that stopped a turn at a plan limit, and when it resets', async () => {
  const { window, id } = await readySession()
  await window.request('sessions.prompt', {
    sessionId: id,
    content: [{ type: 'text', text: '/limit-stop' }],
  })
  await window.until(() => window.summary(id)?.lastTurn?.reason === 'limit')
  const limit = window.summary(id)?.lastTurn?.limit
  expect(window.summary(id)?.lastTurn).toMatchObject({
    reason: 'limit',
    error: "Internal error: You've hit your limit",
    limit: { window: 'five_hour', label: expect.any(String), account: expect.any(String) },
  })
  expect(limit?.resetsAt).toBeGreaterThan(Date.now())
})

it('keeps how the last turn ended across a restart of the host', async () => {
  const dir = await tempFolder('kettu-last-turn-')
  const first = await startTestHost({ userDataPath: dir })
  hosts.push(first)
  const window = first.connect()
  const { id } = await window.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: first.project,
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')
  await window.request('sessions.prompt', {
    sessionId: id,
    content: [{ type: 'text', text: '/error --silent' }],
  })
  await window.until(() => window.summary(id)?.lastTurn?.reason === 'failed')
  const ended = window.summary(id)?.lastTurn
  await first.stop()

  const second = await startTestHost({ userDataPath: dir })
  hosts.push(second)
  const listed = await second.connect().request('sessions.list', {})
  expect(listed.find((summary) => summary.id === id)?.lastTurn).toEqual(ended)
})

it('counts a workflow suggestion that waits among the requests and returns it apart', async () => {
  const host = await startTestHost()
  hosts.push(host)
  const window = host.connect()
  const { id } = await window.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: host.project,
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')
  await window.request('sessions.prompt', {
    sessionId: id,
    content: [{ type: 'text', text: '/plan --step 10' }],
  })
  await window.untilStatus(id, 'ready')
  const cards = host.host.workflowSuggestions
  const draft = await cards.draft(id, WORKFLOW)
  if (!('draftId' in draft)) throw new Error('The workflow did not read')
  const card = await cards.suggest(id, {
    workflowId: draft.draftId,
    task: 'Fix the flaky login test',
    title: null,
    pace: 'balanced',
    paceReason: null,
  })

  await window.until(() => window.summary(id)?.permissionCount === 1)
  expect(window.summary(id)?.attention).toBe('permission')
  const read = await window.request('sessions.requests', { sessionId: id })
  expect(read.entries).toEqual([])
  expect(read.suggestions?.map((s) => [s.id, s.purpose, s.answer.kind])).toEqual([
    [card.id, 'start', 'waiting'],
  ])

  await window.request('workflows.answerSuggestion', { id: card.id, answer: 'decline' })
  await window.until(() => window.summary(id)?.permissionCount === 0)
  expect((await window.request('sessions.requests', { sessionId: id })).suggestions).toEqual([])
})

it('stops counting a waiting suggestion once the next turn starts, across a restart', async () => {
  const dir = await tempFolder('kettu-passed-card-')
  const first = await startTestHost({ userDataPath: dir })
  hosts.push(first)
  const window = first.connect()
  const { id } = await window.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: first.project,
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')
  const cards = first.host.workflowSuggestions
  const draft = await cards.draft(id, WORKFLOW)
  if (!('draftId' in draft)) throw new Error('The workflow did not read')
  const card = await cards.suggest(id, {
    workflowId: draft.draftId,
    task: 'Fix the flaky login test',
    title: null,
    pace: 'balanced',
    paceReason: null,
  })
  await window.until(() => window.summary(id)?.permissionCount === 1)

  // The user talks past it: the next turn starts and the card no longer waits on the session.
  await window.request('sessions.prompt', {
    sessionId: id,
    content: [{ type: 'text', text: '/plan --step 10' }],
  })
  await window.until(() => window.summary(id)?.status === 'running')
  expect(window.summary(id)?.permissionCount).toBe(0)
  await window.untilStatus(id, 'ready')
  expect(window.summary(id)?.permissionCount).toBe(0)
  expect(window.summary(id)?.attention).not.toBe('permission')
  expect((await window.request('sessions.requests', { sessionId: id })).suggestions).toEqual([])
  await first.stop()

  const second = await startTestHost({ userDataPath: dir })
  hosts.push(second)
  const again = second.connect()
  const listed = await again.request('sessions.list', {})
  expect(listed.find((summary) => summary.id === id)?.permissionCount).toBe(0)
  expect((await again.request('sessions.requests', { sessionId: id })).suggestions).toEqual([])
  // The card itself still waits and can be answered.
  const [kept] = await again.request('workflows.suggestions', { sessionId: id })
  expect(kept?.answer.kind).toBe('waiting')
  const answered = await again.request('workflows.answerSuggestion', {
    id: card.id,
    answer: 'decline',
  })
  expect(answered.answer.kind).toBe('declined')
}, 20_000)

it('names the limit a notice ties to a failed turn, unless a turn started since', async () => {
  const { window, id } = await readySession()
  const host = hosts.at(-1)!
  const agents = host.host.agents
  const fiveHour = (state: 'ok' | 'reached') => ({
    window: 'five_hour',
    label: '5-hour',
    usedPercent: state === 'reached' ? 100 : 40,
    resetsAt: Date.now() + 3_600_000,
    state,
    observedAt: Date.now(),
  })
  const say = async (text: string) => {
    await window.request('sessions.prompt', { sessionId: id, content: [{ type: 'text', text }] })
    await window.untilStatus(id, 'ready')
  }
  // A window seen for the first time says nothing.
  agents.setLimit('fake-agent', fiveHour('ok'))

  await say('/error --silent')
  await window.until(() => window.summary(id)?.lastTurn?.reason === 'failed')
  agents.setLimit('fake-agent', fiveHour('reached'))
  await window.until(() => window.summary(id)?.lastTurn?.reason === 'limit')
  expect(window.summary(id)?.lastTurn?.limit).toMatchObject({
    window: 'five_hour',
    label: '5-hour',
  })

  // The window resets, the next turn fails, and a turn starts before the window is used up again.
  agents.setLimit('fake-agent', fiveHour('ok'))
  await say('/error --silent')
  await window.until(() => window.summary(id)?.lastTurn?.reason === 'failed')
  await say('/plan --step 10')
  agents.setLimit('fake-agent', fiveHour('reached'))
  await new Promise((resolve) => setTimeout(resolve, 2_500))
  expect(window.summary(id)?.lastTurn?.reason).toBe('end_turn')
}, 20_000)

const WORKFLOW = `format: 1
name: Fix a bug
description: Reproduce, then fix.
steps:
  - id: reproduce
    name: Reproduce
    prompt: Reproduce the bug.
    outcomes:
      - name: Reproduced
        to: fix
  - id: fix
    name: Fix
    prompt: Fix it.
    outcomes:
      - name: Fixed
        end: done
`
