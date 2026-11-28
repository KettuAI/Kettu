import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { AgentStatus } from '@shared/agent-host'
import { startTestHost, type TestHost, type TestPort } from './testing/harness'
import { tempFolder } from './testing/temp'

const hosts: TestHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
})

function fakeStatus(window: TestPort): AgentStatus | undefined {
  return window.events.findLast(
    (event): event is Extract<typeof event, { type: 'agent.status' }> =>
      event.type === 'agent.status' && event.status.id === 'fake-agent',
  )?.status
}

it('keeps a failed limits read of a running agent in its status until a read succeeds', async () => {
  // The hidden session of the fake agent's `/usage` opens only once this file exists.
  const gate = path.join(await tempFolder('kettu-limits-gate-'), 'open')
  const host = await startTestHost({
    agentEnv: { FAKE_AGENT_NEW_SESSION_GATE: gate },
    agentTimings: { limitsReadMs: 1_000 },
  })
  hosts.push(host)
  const window = host.connect()

  await expect(window.request('agents.refreshAccount', { agentId: 'fake-agent' })).rejects.toThrow()
  await window.until(() => fakeStatus(window)?.state === 'ready')
  expect(fakeStatus(window)).toMatchObject({ limits: [], limitsError: expect.any(String) })

  await writeFile(gate, '')
  await window.request('agents.refreshLimits', { agentId: 'fake-agent', force: true })
  const read = fakeStatus(window)
  expect(read?.limits.length).toBeGreaterThan(0)
  expect(read?.limitsError).toBeUndefined()
})

it('takes a limits report it cannot read for a failed read, without quoting the reply', async () => {
  const host = await startTestHost({ agentEnv: { FAKE_AGENT_USAGE: 'unreadable' } })
  hosts.push(host)
  const window = host.connect()

  await expect(
    window.request('agents.refreshLimits', { agentId: 'fake-agent', force: true }),
  ).rejects.toThrow()
  const failed = fakeStatus(window)
  expect(failed).toMatchObject({ state: 'ready', limits: [], limitsError: expect.any(String) })
  expect(failed?.limitsError).not.toContain('subscription plans')
})

it('drops the plan windows kept from before once an agent goes through a gateway', async () => {
  const dir = await tempFolder('kettu-gateway-limits-')
  await mkdir(path.join(dir, 'state'), { recursive: true })
  const window5h = {
    window: 'five_hour',
    label: '5-hour',
    usedPercent: 50,
    resetsAt: null,
    state: 'ok',
    observedAt: 1,
  }
  await writeFile(
    path.join(dir, 'state', 'agents.json'),
    JSON.stringify({
      version: 1,
      agents: {
        'fake-agent': {
          account: { kind: 'account', label: 'Fake Pro', email: 'developer@example.com' },
          limits: [window5h],
        },
      },
    }),
  )
  const host = await startTestHost({ userDataPath: dir, agentEnv: { FAKE_AGENT_GATEWAY: '1' } })
  hosts.push(host)
  const window = host.connect()

  // A session starts the agent, which reports its account, without reading its limits.
  await window.request('sessions.create', { agentId: 'fake-agent', projectPath: host.project })
  await window.until(() => fakeStatus(window)?.account?.kind === 'gateway')
  expect(fakeStatus(window)?.limits).toEqual([])
})

it('keeps no plan windows for an agent that goes through a gateway, from a read or an event', async () => {
  const host = await startTestHost({ agentEnv: { FAKE_AGENT_GATEWAY: '1' } })
  hosts.push(host)
  const window = host.connect()
  const { id } = await window.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: host.project,
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')
  await window.until(() => fakeStatus(window)?.account?.kind === 'gateway')

  // The plan of a sign-in the gateway does not use still answers a limits read.
  await window.request('agents.refreshLimits', { agentId: 'fake-agent', force: true })
  expect(fakeStatus(window)?.limits).toEqual([])

  // A turn's own rate-limit events say nothing of the gateway's limits either.
  await window.request('sessions.prompt', {
    sessionId: id,
    content: [{ type: 'text', text: 'hi' }],
  })
  await window.untilStatus(id, 'ready')
  expect(fakeStatus(window)?.account?.kind).toBe('gateway')
  expect(fakeStatus(window)?.limits).toEqual([])
})

it('covers a used-up window with extra usage until an event says it is over', async () => {
  const host = await startTestHost()
  hosts.push(host)
  const window = host.connect()
  const { id } = await window.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: host.project,
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')
  const say = async (text: string) => {
    await window.request('sessions.prompt', { sessionId: id, content: [{ type: 'text', text }] })
    await window.untilStatus(id, 'ready')
  }
  const fiveHour = () => fakeStatus(window)?.limits.find((limit) => limit.window === 'five_hour')

  await say('/extra-usage')
  await window.until(() => fiveHour()?.extraUsage === true)
  expect(fiveHour()).toMatchObject({ state: 'reached', usedPercent: 100, extraUsage: true })

  // Extra usage stops covering the window while it is still used up: the block stays.
  await say('/extra-usage refused')
  await window.until(() => fiveHour()?.extraUsage === undefined)
  expect(fiveHour()).toMatchObject({ state: 'reached', usedPercent: 100 })

  await say('/extra-usage off')
  await window.until(() => fiveHour()?.extraUsage === undefined && fiveHour()?.state === 'ok')
  expect(fiveHour()).toMatchObject({ usedPercent: 12, state: 'ok' })
})

it('backs off background limit reads after failures while still honoring forced refreshes', async () => {
  const host = await startTestHost({
    agentEnv: { FAKE_AGENT_USAGE: 'unreadable' },
    agentTimings: { limitsMs: 10, limitsBackgroundMs: 100 },
  })
  hosts.push(host)
  const window = host.connect()
  const { id } = await window.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: host.project,
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')

  // First failure puts the agent into backoff; a non-forced refresh immediately after returns
  // without issuing another failing read, while force:true bypasses the backoff.
  await expect(
    window.request('agents.refreshLimits', { agentId: 'fake-agent', force: true }),
  ).rejects.toThrow()
  await expect(
    window.request('agents.refreshLimits', { agentId: 'fake-agent' }),
  ).resolves.toBeUndefined()
  await expect(
    window.request('agents.refreshLimits', { agentId: 'fake-agent', force: true }),
  ).rejects.toThrow()
})

it('skips background limit polling when an agent only has un-adopted prepared sessions', async () => {
  const host = await startTestHost({
    agentEnv: { FAKE_AGENT_USAGE: 'unreadable' },
    agentTimings: { limitsMs: 10, limitsBackgroundMs: 40 },
  })
  hosts.push(host)
  const window = host.connect()
  const prepared = await window.request('sessions.prepare', {
    agentId: 'fake-agent',
    projectPath: host.project,
  })
  expect(prepared.prepared).toBeDefined()

  await new Promise((resolve) => setTimeout(resolve, 160))
  expect(fakeStatus(window)?.limitsError).toBeUndefined()
})

it('excludes stale and archived sessions from activitySummaries while keeping live and recent ones', async () => {
  const host = await startTestHost()
  hosts.push(host)
  const window = host.connect()
  const { id: liveId } = await window.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: host.project,
  })
  await window.open(liveId)
  await window.untilStatus(liveId, 'ready')

  const { id: archivedId } = await window.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: host.project,
  })
  await window.request('sessions.archive', { sessionId: archivedId })

  const now = Date.now()
  const active = host.host.sessions.activitySummaries(now)
  expect(active.map((s) => s.id)).toContain(liveId)
  expect(active.map((s) => s.id)).not.toContain(archivedId)

  // Advancing `now` past the 30-minute window drops closed old records while keeping live sessions.
  const future = host.host.sessions.activitySummaries(now + 60 * 60_000)
  expect(future.map((s) => s.id)).toContain(liveId)
})
