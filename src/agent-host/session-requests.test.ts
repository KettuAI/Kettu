import { afterEach, expect, it } from 'vitest'
import { startTestHost, type TestHost, type TestPort } from './testing/harness'

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
