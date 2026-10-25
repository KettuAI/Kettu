// Integration tests: the message outline's list of user messages and the titles the session's
// agent writes for them, through the host with the fake agent.

import { afterEach, describe, expect, it } from 'vitest'
import { startTestHost, type TestHost, type TestPort } from './testing/harness'

let hosts: TestHost[] = []

afterEach(async () => {
  for (const host of hosts.reverse()) await host.stop()
  hosts = []
})

async function setup(options: Parameters<typeof startTestHost>[0] = {}) {
  const t = await startTestHost(options)
  hosts.push(t)
  return { t, port: t.connect() }
}

async function newSession(t: TestHost, port: TestPort): Promise<string> {
  const summary = await port.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: t.project,
  })
  await port.open(summary.id)
  return summary.id
}

async function send(port: TestPort, sessionId: string, prompt: string): Promise<void> {
  const ends = port.entries(sessionId).filter((entry) => entry.kind === 'turn_end').length
  await port.request('sessions.queue', { sessionId, content: [{ type: 'text', text: prompt }] })
  await port.until(
    () => port.entries(sessionId).filter((entry) => entry.kind === 'turn_end').length > ends,
  )
  await port.untilStatus(sessionId, 'ready')
}

const warnings = (t: TestHost, text: string) =>
  t.host.diagnostics
    .logEntries()
    .filter((entry) => entry.level === 'warn' && entry.message.includes(text))

describe('the message outline', () => {
  it('lists the user messages of a live session, those not stored yet included', async () => {
    // No checkpoint falls due during the test, so only the outline's own flush stores them.
    const { t, port } = await setup({ sessionTimings: { checkpointMs: 600_000 } })
    const sessionId = await newSession(t, port)
    await send(port, sessionId, '\n  Fix the flaky login test\nIt fails on Safari')
    await send(port, sessionId, 'Now the signup form')
    const users = port.entries(sessionId).filter((entry) => entry.kind === 'user')

    const { entries } = await port.request('sessions.outline', { sessionId })
    expect(entries).toEqual([
      {
        pos: expect.any(Number),
        entryId: users[0]!.id,
        text: 'Fix the flaky login test',
        title: null,
      },
      { pos: expect.any(Number), entryId: users[1]!.id, text: 'Now the signup form', title: null },
    ])
    await t.host.threads!.flush()
    expect((await t.host.threads!.outline(sessionId))?.entries).toHaveLength(2)
  })

  it('loads a live thread back to the turn of a message in one page', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    for (let i = 0; i < 3; i++) await send(port, sessionId, '/tool-storm --count 70')
    const snapshot = await port.request('sessions.snapshot', { sessionId })
    const { entries } = await port.request('sessions.outline', { sessionId })
    expect(entries).toHaveLength(3)
    expect(snapshot.older).not.toBeNull()
    expect(snapshot.older!).toBeGreaterThan(entries[1]!.pos)

    const page = await port.request('sessions.page', {
      sessionId,
      before: snapshot.older!,
      from: entries[0]!.pos,
    })
    expect(page.entries[0]!.id).toBe(entries[0]!.entryId)
    expect(page.older).toBeNull()
    expect([...page.entries, ...snapshot.entries]).toEqual(port.entries(sessionId))
  })

  it('has the agent title the untitled messages once, and keeps the titles', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    await send(port, sessionId, 'Fix the flaky login test')
    await send(port, sessionId, 'Now the signup form please')

    const { titles } = await port.request('sessions.outlineTitles', { sessionId })
    expect(titles.map((title) => title.title).sort()).toEqual(['Fix the flaky', 'Now the signup'])
    const { entries } = await port.request('sessions.outline', { sessionId })
    expect(entries.map((entry) => entry.title)).toEqual(['Fix the flaky', 'Now the signup'])
    // Every message has its title, so nothing is asked again.
    expect(await port.request('sessions.outlineTitles', { sessionId })).toEqual({ titles: [] })
    // The hidden session it ran in is in no list.
    expect(await port.request('sessions.list', {})).toHaveLength(1)
  })

  it('runs one summary at a time for a session', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    await send(port, sessionId, 'Take your time /slow')
    await send(port, sessionId, 'Second message')
    const [first, second] = await Promise.all([
      port.request('sessions.outlineTitles', { sessionId }),
      port.request('sessions.outlineTitles', { sessionId }),
    ])
    expect(first.titles).toHaveLength(2)
    expect(second.titles).toEqual([])
  })

  it('waits before trying again after a summary failed', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    await send(port, sessionId, 'Answer in prose /garbage')
    await send(port, sessionId, 'Second message')
    expect(await port.request('sessions.outlineTitles', { sessionId })).toEqual({ titles: [] })
    expect(warnings(t, 'could not title the outline')).toHaveLength(1)
    expect(await port.request('sessions.outlineTitles', { sessionId })).toEqual({ titles: [] })
    expect(warnings(t, 'could not title the outline')).toHaveLength(1)
  })

  it('rejects any permission the summary asks for', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    await send(port, sessionId, 'Look around /permission')
    await send(port, sessionId, 'Second message')
    const { titles } = await port.request('sessions.outlineTitles', { sessionId })
    expect(titles.map((title) => title.title)).toContain('Permission cancelled')
    expect(port.summary(sessionId)?.permissionCount ?? 0).toBe(0)
  })
})
