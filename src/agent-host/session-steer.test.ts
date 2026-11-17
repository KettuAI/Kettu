import { afterEach, expect, it, vi } from 'vitest'
import { FakeAppServer, turn } from './testing/fake-app-server'
import { startTestHost, type TestHost } from './testing/harness'

const hosts: TestHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
})

const PROMPT = 'ask me something'

/** A Codex session whose turn waits on a question. */
async function askedSession() {
  const server = new FakeAppServer()
  // The session also starts a hidden thread to title itself, so the turn is found by its text.
  const started: { threadId?: string; turnId?: string } = {}
  server.on('turn/start', (params, self) => {
    const turnId = self.nextTurnId()
    const input = params.input as { text?: string }[]
    if (input[0]?.text === PROMPT) Object.assign(started, { threadId: params.threadId, turnId })
    return { turn: turn(turnId) }
  })
  const host = await startTestHost({ fakeAppServer: server })
  hosts.push(host)
  const window = host.connect()
  const { id } = await window.request('sessions.create', {
    agentId: 'codex',
    projectPath: host.project,
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')
  void window.request('sessions.prompt', {
    sessionId: id,
    content: [{ type: 'text', text: PROMPT }],
  })
  // The fake server is no port event, so the wait polls.
  await vi.waitFor(() => expect(started.turnId).toBeDefined())
  const asked = server.request('item/tool/requestUserInput', {
    ...started,
    itemId: 'ask-1',
    questions: [
      {
        id: 'q',
        header: 'Indent',
        question: 'Tabs or spaces?',
        isOther: true,
        isSecret: false,
        options: [
          { label: 'Tabs', description: '' },
          { label: 'Spaces', description: '' },
        ],
      },
    ],
  })
  await window.untilStatus(id, 'awaiting_permission')
  return { server, window, id, asked }
}

it('skips a waiting question when a message is sent into the turn', async () => {
  const { server, window, id, asked } = await askedSession()
  const { itemId } = await window.request('sessions.queue', {
    sessionId: id,
    content: [{ type: 'text', text: 'pick tabs' }],
  })
  await window.request('sessions.steer', { sessionId: id, itemId: itemId! })

  expect(server.sent('turn/steer')).toHaveLength(1)
  // Codex holds the turn until the question is answered, so the message would never be read.
  let answer: unknown
  void asked.answer.then((value) => (answer = value))
  await vi.waitFor(() => expect(answer).toEqual({ answers: {} }), { timeout: 2000 })
  await window.untilStatus(id, 'running')
  const ask = window.entries(id).find((entry) => entry.kind === 'tool' && entry.question)
  expect(ask).toMatchObject({ permissionResult: { kind: 'reject_once' } })
})
