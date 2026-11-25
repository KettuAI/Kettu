import { afterEach, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@shared/agent-host'
import { startTestHost, type TestHost } from './testing/harness'

vi.setConfig({ testTimeout: 60_000 })

const hosts: TestHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
})

async function readySession() {
  const host = await startTestHost()
  hosts.push(host)
  const window = host.connect()
  const { id } = await window.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: host.project,
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')
  const prompt = (text: string) =>
    window.request('sessions.prompt', { sessionId: id, content: [{ type: 'text', text }] })
  return { window, id, prompt }
}

const ONE_SUBAGENT = { commands: 0, subagents: 1, reportsBack: false }

it('says a subagent runs on after the turn, until it ends', async () => {
  const { window, id, prompt } = await readySession()
  await prompt('/subagent --then 1500')
  await window.until(() => window.entries(id).some((entry) => entry.kind === 'turn_end'))
  await window.until(() => window.summary(id)?.stillRunning != null)
  expect(window.summary(id)).toMatchObject({ status: 'ready', stillRunning: ONE_SUBAGENT })

  await window.until(() => window.summary(id)?.stillRunning === null)
  expect(window.summary(id)?.status).toBe('ready')
})

it('says nothing runs on while the next turn runs, and again once it ends', async () => {
  const { window, id, prompt } = await readySession()
  await prompt('/subagent --then 20000')
  await window.until(() => window.summary(id)?.stillRunning != null)

  const before = window.events.length
  await prompt('/basic-turn')
  await window.until(() =>
    window.events
      .slice(before)
      .some((event) => event.type === 'session.summary' && event.summary.status === 'running'),
  )
  const during = window.events
    .slice(before)
    .flatMap((event): SessionSummary[] =>
      event.type === 'session.summary' && event.summary.id === id ? [event.summary] : [],
    )
    .filter((summary) => summary.status === 'running')
  expect(during.length).toBeGreaterThan(0)
  expect(during.every((summary) => summary.stillRunning === null)).toBe(true)

  await window.untilStatus(id, 'ready')
  await window.until(() => window.summary(id)?.stillRunning != null)
  expect(window.summary(id)?.stillRunning).toEqual(ONE_SUBAGENT)
})
