import { afterEach, expect, it } from 'vitest'
import { startTestHost, type TestHost, type TestPort } from '../testing/harness'

let host: TestHost | null = null

afterEach(async () => {
  await host?.stop()
  host = null
})

/** Sends a prompt and gives the agent's reply once its turn is over. */
async function reply(port: TestPort, sessionId: string, text: string): Promise<string> {
  const replies = () =>
    port.entries(sessionId).flatMap((entry) => (entry.kind === 'agent' ? [entry] : []))
  const before = replies().length
  await port.request('sessions.prompt', { sessionId, content: [{ type: 'text', text }] })
  await port.until(
    () =>
      replies().length > before &&
      !replies().at(-1)!.streaming &&
      port.summary(sessionId)?.status === 'ready',
  )
  return replies().at(-1)!.markdown
}

it("hands Kettu's guide and memory ahead of the first prompt that is not a slash command, once", async () => {
  host = await startTestHost()
  const window = host.connect()
  await window.request('memory.save', {
    scope: { layer: 'global' },
    id: null,
    draft: {
      title: 'Replies in Chinese',
      description: 'The user reads Simplified Chinese.',
      body: 'Answer in Simplified Chinese.',
    },
  })
  const { id } = await window.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: host.project,
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')

  // An agent sees a slash command only at the very start of a prompt.
  expect(await reply(window, id, '/recall')).toBe('You have not said anything before.')
  await reply(window, id, 'hello')
  const recalled = await reply(window, id, '/recall')
  // An agent that takes no skills is pointed at the guide's topics.
  expect(recalled).toMatch(/^Your last message was: <kettu-guide>\n[^<]*read_kettu_guide/)
  expect(recalled).toContain('</kettu-guide>\n\n<kettu-memory>')
  expect(recalled).toContain('Replies in Chinese')
  expect(recalled.endsWith('</kettu-memory>\n\nhello')).toBe(true)
  expect(await reply(window, id, '/recall')).toBe('Your last message was: /recall')
})

it('hands memory turned on in a session with its next prompt, and the guide again with it', async () => {
  host = await startTestHost()
  const window = host.connect()
  await window.request('memory.setEnabled', { enabled: false })
  const { id } = await window.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: host.project,
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')

  await reply(window, id, 'hello')
  const first = await reply(window, id, '/recall')
  expect(first).toMatch(/^Your last message was: <kettu-guide>/)
  expect(first).not.toContain('<kettu-memory>')
  expect(first.endsWith('</kettu-guide>\n\nhello')).toBe(true)

  await window.request('memory.setEnabled', { enabled: true })
  await reply(window, id, 'again')
  const next = await reply(window, id, '/recall')
  expect(next).toMatch(/^Your last message was: <kettu-guide>/)
  expect(next.endsWith('</kettu-memory>\n\nagain')).toBe(true)
})

// The fake agent as agy 1.5.9, which takes a new session's system prompt addition.
const AGY = {
  fakeAs: ['antigravity' as const],
  agentEnv: { FAKE_AGENT_VERSION: '1.5.9', FAKE_AGENT_SYSTEM_PROMPT: '1' },
}

/** Sends a prompt and waits for its turn to end, for one with no reply of its own. */
async function finish(port: TestPort, sessionId: string, text: string): Promise<void> {
  const ends = () => port.entries(sessionId).filter((entry) => entry.kind === 'turn_end').length
  const before = ends()
  await port.request('sessions.prompt', { sessionId, content: [{ type: 'text', text }] })
  await port.until(() => ends() > before && port.summary(sessionId)?.status === 'ready')
}

it("puts Kettu's guide and memory in a new agy session's system prompt, and sends them no more", async () => {
  host = await startTestHost(AGY)
  const window = host.connect()
  const { id } = await window.request('sessions.create', {
    agentId: 'antigravity',
    projectPath: host.project,
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')

  const prompt = await reply(window, id, '/instructions')
  expect(prompt).toMatch(/^<kettu-guide>\n[^<]*read_kettu_guide/)
  expect(prompt).toContain('<kettu-memory>')
  await reply(window, id, 'hello')
  expect(await reply(window, id, '/recall')).toBe('Your last message was: hello')
  // A compacted context keeps the system prompt, so nothing goes ahead of the next prompt.
  await finish(window, id, '/compact')
  await reply(window, id, 'again')
  expect(await reply(window, id, '/recall')).toBe('Your last message was: again')
})

it('still sends the guide and memory ahead of an agy session it did not create, and again after compaction', async () => {
  host = await startTestHost(AGY)
  const window = host.connect()
  // A session of agy's own history, from the Antigravity app or CLI: no system prompt addition.
  const { id } = await window.request('sessions.import', {
    agentId: 'antigravity',
    projectPath: host.project,
    acpSessionId: 'cli-refactor-router',
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')

  await reply(window, id, 'hello')
  const first = await reply(window, id, '/recall')
  expect(first).toMatch(/^Your last message was: <kettu-guide>\n[^<]*read_kettu_guide/)
  expect(first.endsWith('</kettu-memory>\n\nhello')).toBe(true)
  expect(await reply(window, id, '/recall')).toBe('Your last message was: /recall')

  await finish(window, id, '/compact')
  await reply(window, id, 'again')
  const next = await reply(window, id, '/recall')
  expect(next).toMatch(/^Your last message was: <kettu-guide>/)
  expect(next.endsWith('</kettu-memory>\n\nagain')).toBe(true)
})
