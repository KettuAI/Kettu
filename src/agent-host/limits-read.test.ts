import { writeFile } from 'node:fs/promises'
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
