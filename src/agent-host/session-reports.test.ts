import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ThreadEntry } from '@shared/thread'
import { turnRoundOf } from './sessions'
import { startTestHost, type TestHost, type TestPort } from './testing/harness'
import { tempFolder } from './testing/temp'

// A host starts and runs two sessions; a busy machine takes longer than the 5 s default.
vi.setConfig({ testTimeout: 60_000 })

const hosts: TestHost[] = []
const tempDirs: string[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
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

it('pauses reports at the limit the settings set, and says so once', async () => {
  const host = await startTestHost({ startedSessions: { working: 3, daily: 10, reports: 1 } })
  hosts.push(host)
  const window = host.connect()
  const { id: callerId } = await window.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: host.project,
  })
  await window.open(callerId)
  await window.untilStatus(callerId, 'ready')

  await host.host.sessions.startFromTool(callerId, { prompt: 'One.', options: {}, report: true })
  await window.untilEntry(callerId, isReport)
  await window.untilEntry(callerId, (entry) => entry.kind === 'turn_end')
  await window.untilStatus(callerId, 'ready')

  await host.host.sessions.startFromTool(callerId, { prompt: 'Two.', options: {}, report: true })
  await window.untilEntry(
    callerId,
    (entry) => entry.kind === 'notice' && entry.cause === 'reports_paused',
  )
  const notices = window
    .entries(callerId)
    .filter((entry) => entry.kind === 'notice' && entry.cause === 'reports_paused')
  expect(notices).toHaveLength(1)
  expect(window.entries(callerId).filter(isReport)).toHaveLength(1)
  expect(window.thread(callerId).session.queue).toEqual([])
})

describe('turnRoundOf', () => {
  const user = (
    id: string,
    extra: Partial<Extract<ThreadEntry, { kind: 'user' }>> = {},
  ): Extract<ThreadEntry, { kind: 'user' }> => ({
    kind: 'user',
    id,
    content: [{ type: 'text', text: id }],
    ...extra,
  })
  const agent = (id: string): ThreadEntry => ({
    kind: 'agent',
    id,
    markdown: 'ok',
    attachments: [],
    streaming: false,
  })

  it('counts only non-steered, non-approval, non-report user turn starts up to the entry', () => {
    const entries: ThreadEntry[] = [
      user('u1'),
      user('u1-steer', { steered: true }),
      agent('a1'),
      user('u-approve', { approval: true }),
      user('u-grandchild-report', {
        from: {
          sessionId: 'grandchild',
          title: 'Sub',
          ended: { agent: 'Fake Agent', stopReason: 'end_turn', round: 1 },
        },
      }),
      user('u2'),
      agent('a2'),
      user('u3'),
    ]
    const thread = {
      order: entries.map((e) => e.id),
      byId: Object.fromEntries(entries.map((e) => [e.id, e])),
    }
    expect(turnRoundOf(thread, 'u1')).toBe(1)
    expect(turnRoundOf(thread, 'u2')).toBe(2)
    expect(turnRoundOf(thread, 'u3')).toBe(3)
    expect(turnRoundOf(thread, 'missing')).toBeUndefined()
  })
})

it('increments round metadata across follow-up turns with accurate timestamps and child round anchors', async () => {
  const host = await startTestHost()
  hosts.push(host)
  const window = host.connect()
  const { id: callerId } = await window.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: host.project,
  })
  await window.open(callerId)
  await window.untilStatus(callerId, 'ready')

  const childId = await host.host.sessions.startFromTool(callerId, {
    prompt: 'Round one task.',
    options: {},
    report: true,
  })
  await window.open(childId)

  await window.until(() => window.entries(callerId).filter(isReport).length === 1)
  await window.untilStatus(callerId, 'ready')

  const fromCaller = { sessionId: callerId, title: 'Caller' }
  await host.host.sessions.sendFromTool(childId, 'Round two follow-up.', fromCaller, false)
  await window.until(() => window.entries(callerId).filter(isReport).length === 2)
  await window.untilStatus(callerId, 'ready')

  await host.host.sessions.sendFromTool(childId, 'Round three follow-up.', fromCaller, false)
  await window.until(() => window.entries(callerId).filter(isReport).length === 3)
  await window.untilStatus(callerId, 'ready')

  const reports = window
    .entries(callerId)
    .filter((entry): entry is Extract<ThreadEntry, { kind: 'user' }> => isReport(entry))
  const childUserIds = window
    .entries(childId)
    .filter((entry) => entry.kind === 'user' && !entry.steered)
    .map((entry) => entry.id)

  expect(reports).toHaveLength(3)
  expect(childUserIds).toHaveLength(3)
  expect(reports.map((entry) => entry.from?.ended?.round)).toEqual([1, 2, 3])
  expect(reports.map((entry) => entry.from?.ended?.entryId)).toEqual(childUserIds)
  for (let i = 0; i < reports.length; i++) {
    const ended = reports[i]!.from!.ended!
    expect(typeof ended.completedAt).toBe('number')
    expect(ended.completedAt!).toBeGreaterThan(0)
    expect(typeof ended.pos).toBe('number')
    expect(ended.pos!).toBeGreaterThanOrEqual(0)
    if (i > 0) {
      expect(ended.completedAt!).toBeGreaterThanOrEqual(reports[i - 1]!.from!.ended!.completedAt!)
      expect(ended.pos!).toBeGreaterThan(reports[i - 1]!.from!.ended!.pos!)
    }
    const text = reports[i]!.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
    expect(text).toContain(`round ${i + 1}`)
  }
})

it('preserves exact round metadata from composer queue to thread history', async () => {
  const { host, window, callerId } = await busyCaller()
  const childId = await host.host.sessions.startFromTool(callerId, {
    prompt: 'Queued round task.',
    options: {},
    report: true,
  })
  await window.until(() => window.thread(callerId).session.queue.some((item) => item.from?.ended))

  const queued = window.thread(callerId).session.queue.find((item) => item.from?.ended)
  expect(queued?.from?.ended).toBeDefined()
  expect(queued?.from?.ended?.round).toBe(1)
  expect(typeof queued?.from?.ended?.completedAt).toBe('number')
  expect(queued?.from?.ended?.entryId).toBeTruthy()
  expect(typeof queued?.from?.ended?.pos).toBe('number')

  const queuedEnded = { ...queued!.from!.ended! }
  await allow(window, callerId)
  await window.untilEntry(callerId, isReport)

  const delivered = window
    .entries(callerId)
    .find((entry): entry is Extract<ThreadEntry, { kind: 'user' }> => isReport(entry))
  expect(delivered?.from?.ended).toEqual(queuedEnded)
  expect(delivered?.from?.sessionId).toBe(childId)
})

it('keeps incrementing child session round numbers accurately after host restart', async () => {
  const dir = await tempFolder('kettu-report-restart-')
  tempDirs.push(dir)

  const first = await startTestHost({ userDataPath: dir })
  hosts.push(first)
  const w1 = first.connect()
  const { id: callerId } = await w1.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: first.project,
  })
  await w1.open(callerId)
  await w1.untilStatus(callerId, 'ready')

  const childId = await first.host.sessions.startFromTool(callerId, {
    prompt: 'Before restart.',
    options: {},
    report: true,
  })
  await w1.until(() => w1.entries(callerId).filter(isReport).length === 1)
  await w1.untilStatus(callerId, 'ready')

  const firstReport = w1
    .entries(callerId)
    .find((entry): entry is Extract<ThreadEntry, { kind: 'user' }> => isReport(entry))
  expect(firstReport?.from?.ended?.round).toBe(1)

  // Stop the first host (flushing checkpoints and sessions.json) and start a fresh host on the same data dir.
  hosts.pop()
  await first.stop()

  const second = await startTestHost({ userDataPath: dir })
  hosts.push(second)
  const w2 = second.connect()
  await w2.open(callerId)
  await w2.open(childId)

  await second.host.sessions.sendFromTool(
    childId,
    'After restart follow-up.',
    { sessionId: callerId, title: 'Caller' },
    false,
  )
  await w2.until(() => w2.entries(callerId).filter(isReport).length === 2)
  await w2.untilStatus(callerId, 'ready')

  const reports = w2
    .entries(callerId)
    .filter((entry): entry is Extract<ThreadEntry, { kind: 'user' }> => isReport(entry))
  expect(reports.map((entry) => entry.from?.ended?.round)).toEqual([1, 2])
  expect(reports[1]!.from!.ended!.entryId).not.toBe(reports[0]!.from!.ended!.entryId)
  expect(reports[1]!.from!.ended!.completedAt!).toBeGreaterThanOrEqual(
    reports[0]!.from!.ended!.completedAt!,
  )
})
