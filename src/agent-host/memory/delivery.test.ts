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

it('hands memory ahead of the first prompt that is not a slash command, once', async () => {
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
  expect(recalled).toMatch(/^Your last message was: <kettu-memory>/)
  expect(recalled).toContain('Replies in Chinese')
  expect(recalled.endsWith('</kettu-memory>\n\nhello')).toBe(true)
  expect(await reply(window, id, '/recall')).toBe('Your last message was: /recall')
})
