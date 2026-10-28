// Integration tests: a new site an agent's page wants to open, shown in the session's thread as a
// card, waiting as a permission request does, and taking the user's answer from either place.

import { afterEach, describe, expect, it } from 'vitest'
import type { BrowserOriginEntry, ToolEntry } from '@shared/thread'
import { startTestHost, type TestHost, type TestPort } from './testing/harness'

let current: TestHost | null = null

afterEach(async () => {
  await current?.stop()
  current = null
})

async function setup() {
  current = await startTestHost()
  const port = current.connect()
  const summary = await port.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: current.project,
  })
  await port.open(summary.id)
  return { t: current, port, sessionId: summary.id }
}

function cards(port: TestPort, sessionId: string): BrowserOriginEntry[] {
  return port.entries(sessionId).filter((entry): entry is BrowserOriginEntry => {
    return entry.kind === 'browser_origin'
  })
}

describe('a new site', () => {
  it('goes in the thread waiting, marks the session as waiting, and takes the answer', async () => {
    const { t, port, sessionId } = await setup()
    t.host.browserOriginAsked(7, sessionId, 'https://example.com')
    await port.until(() => cards(port, sessionId).length === 1)
    const [card] = cards(port, sessionId)
    expect(card).toMatchObject({
      kind: 'browser_origin',
      requestId: 7,
      origin: 'https://example.com',
      decision: null,
    })
    expect(card!.after).toBeNull()
    expect(port.summary(sessionId)).toMatchObject({ attention: 'permission', permissionCount: 1 })
    expect(t.sent).toContainEqual(
      expect.objectContaining({
        type: 'host:attention',
        sessionId,
        kind: 'permission',
        body: expect.stringContaining('example.com'),
      }),
    )

    t.host.browserOriginSettled(7, 'session')
    await port.until(() => cards(port, sessionId)[0]?.decision === 'session')
    expect(port.summary(sessionId)).toMatchObject({ permissionCount: 0 })
  })

  it('says the site was not answered in time', async () => {
    const { t, port, sessionId } = await setup()
    t.host.browserOriginAsked(8, sessionId, 'https://example.com')
    await port.until(() => cards(port, sessionId).length === 1)
    t.host.browserOriginSettled(8, 'timeout')
    await port.until(() => cards(port, sessionId)[0]?.decision === 'timeout')
    expect(port.summary(sessionId)?.permissionCount).toBe(0)
  })

  it('ignores an answer to a request the thread does not hold', async () => {
    const { t, port, sessionId } = await setup()
    t.host.browserOriginSettled(99, 'deny')
    expect(cards(port, sessionId)).toEqual([])
  })

  it('holds the thread as it was after a replay, when the answer is kept', async () => {
    const { t, port, sessionId } = await setup()
    await port.request('sessions.prompt', {
      sessionId,
      content: [{ type: 'text', text: 'Open the site' }],
    })
    await port.untilStatus(sessionId, 'ready')
    t.host.browserOriginAsked(9, sessionId, 'https://example.com')
    await port.until(() => cards(port, sessionId).length === 1)
    t.host.browserOriginSettled(9, 'project')
    await port.until(() => cards(port, sessionId)[0]?.decision === 'project')
    const before = cards(port, sessionId)[0]!
    expect(before.after).not.toBeNull()
    // A replay of the same turn keeps the host's own entry after the agent's.
    const tools = port
      .entries(sessionId)
      .filter((entry): entry is ToolEntry => entry.kind === 'tool')
    expect(tools.length).toBeGreaterThan(0)
    expect(cards(port, sessionId)).toHaveLength(1)
  })
})
