import { afterEach, expect, it, vi } from 'vitest'
import type { ThreadEntry } from '@shared/thread'
import { startTestHost, type TestHost, type TestPort } from './testing/harness'

// A host starts and runs two sessions; a busy machine takes longer than the 5 s default.
vi.setConfig({ testTimeout: 60_000 })

const hosts: TestHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
})

const isReport = (entry: ThreadEntry) => entry.kind === 'user' && entry.from?.ended !== undefined

/** Allows the permission card a session's turn is held on, which lets the turn end. */
async function allow(window: TestPort, sessionId: string): Promise<void> {
  await window.untilStatus(sessionId, 'awaiting_permission')
  const held = window
    .entries(sessionId)
    .find((entry) => entry.kind === 'tool' && entry.permission !== null)
  if (held?.kind !== 'tool' || !held.permission) throw new Error('No permission card')
  await window.request('permissions.respond', {
    sessionId,
    requestId: held.permission.requestId,
    optionId: 'allow-once',
  })
}

/** A caller held on a permission card, so a report from a session it starts waits in its queue. */
async function busyCaller(): Promise<{ host: TestHost; window: TestPort; callerId: string }> {
  const host = await startTestHost()
  hosts.push(host)
  const window = host.connect()
  const { id: callerId } = await window.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: host.project,
  })
  await window.open(callerId)
  await window.untilStatus(callerId, 'ready')
  await window.request('sessions.prompt', {
    sessionId: callerId,
    content: [{ type: 'text', text: '/permission' }],
  })
  await window.untilStatus(callerId, 'awaiting_permission')
  return { host, window, callerId }
}

it('drops a queued report once the caller archives the session it reports on', async () => {
  const { host, window, callerId } = await busyCaller()
  const startedId = await host.host.sessions.startFromTool(callerId, {
    prompt: 'Check the login page.',
    options: {},
    report: true,
  })
  await window.until(() => window.thread(callerId).session.queue.some((item) => item.from?.ended))

  await host.host.sessions.archiveStarted(startedId, 'Fake Agent')
  await window.until(() => window.thread(callerId).session.queue.length === 0)

  await allow(window, callerId)
  await window.untilEntry(callerId, (entry) => entry.kind === 'turn_end')
  await window.untilStatus(callerId, 'ready')
  expect(window.entries(callerId).filter(isReport)).toEqual([])
  expect(window.thread(callerId).session.queue).toEqual([])
})

it('still reports a turn whose session archives itself when it ends', async () => {
  const { host, window, callerId } = await busyCaller()
  const startedId = await host.host.sessions.startFromTool(callerId, {
    prompt: '/permission',
    options: {},
    report: true,
  })
  await window.open(startedId)
  await window.untilStatus(startedId, 'awaiting_permission')
  host.host.sessions.archiveWhenIdle(startedId, 'Fake Agent')
  await allow(window, startedId)
  await window.until(() => window.thread(callerId).session.queue.some((item) => item.from?.ended))

  await allow(window, callerId)
  await window.untilEntry(callerId, isReport)
})
