import { afterEach, expect, it, vi } from 'vitest'
import type { ThreadEntry } from '@shared/thread'
import { FakeAppServer, turn } from './testing/fake-app-server'
import { startTestHost, type TestHost } from './testing/harness'

const hosts: TestHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
})

const PROMPT = 'ask me something'

/** A Codex session with a turn that runs. */
async function runningSession() {
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
  return { server, host, window, id, started }
}

/** A Codex session whose turn waits on a question. */
async function askedSession() {
  const { server, window, id, started } = await runningSession()
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

/** A Codex session whose turn goes on while a question it asked waits for the user. */
async function asyncAskedSession() {
  const { server, window, id, started } = await runningSession()
  server.notify('item/completed', {
    ...started,
    item: {
      type: 'agentMessage',
      id: 'call-1',
      text: 'Tabs or spaces?',
      phase: 'final_answer',
      delivery: 'async',
      questions: [{ title: 'Tabs or spaces?', options: ['Tabs', 'Spaces'] }],
    },
  })
  await window.untilEntry(id, (entry) => entry.kind === 'tool' && entry.permission !== null)
  return { server, window, id }
}

it('keeps a question the turn does not wait for when a message is sent into it', async () => {
  const { server, window, id } = await asyncAskedSession()
  expect(window.summary(id)?.status).toBe('running')
  const { itemId } = await window.request('sessions.queue', {
    sessionId: id,
    content: [{ type: 'text', text: 'pick tabs' }],
  })
  await window.request('sessions.steer', { sessionId: id, itemId: itemId! })

  expect(server.sent('turn/steer')).toHaveLength(1)
  const ask = window.entries(id).find((entry) => entry.kind === 'tool' && entry.question)
  expect(ask).toMatchObject({ permission: { questions: [{ question: 'Tabs or spaces?' }] } })
})

it('answers a question the turn does not wait for into the running turn', async () => {
  const { server, window, id } = await asyncAskedSession()
  const ask = window.entries(id).find((entry) => entry.kind === 'tool' && entry.permission)
  const requestId = ask?.kind === 'tool' ? ask.permission!.requestId : ''
  await window.request('permissions.respond', {
    sessionId: id,
    requestId,
    answers: [{ question: 0, choices: [1] }],
  })

  await vi.waitFor(() => expect(server.sent('turn/steer')).toHaveLength(1))
  const input = (server.sent('turn/steer')[0]!.input as { text: string }[])[0]!
  expect(input.text).toContain('<send_user_message_question_reply>')
  expect(input.text).toContain('"answer":"Spaces"')
  expect(window.thread(id).session.queue).toHaveLength(0)
})

it("drops a message of Kettu's that is no longer due when its turn comes, and sends the next", async () => {
  const { server, host, window, id, started } = await runningSession()
  let due = true
  await host.host.sessions.sendFromKettu(id, 'Your step is not reported yet.', () => due)
  await host.host.sessions.sendFromKettu(id, 'Your step was sent back.', () => true)
  await vi.waitFor(() => expect(window.thread(id).session.queue).toHaveLength(2))
  // The step reports while the messages wait.
  due = false
  server.notify('turn/completed', {
    threadId: started.threadId,
    turn: turn(started.turnId!, 'completed'),
  })

  const texts = () =>
    server.sent('turn/start').map((p) => (p.input as { text?: string }[])[0]?.text)
  await vi.waitFor(() => expect(texts()).toContain('Your step was sent back.'))
  expect(texts()).not.toContain('Your step is not reported yet.')
  await vi.waitFor(() => expect(window.thread(id).session.queue).toHaveLength(0))
})

it("marks Kettu's own messages as Kettu's, queued, steered into the turn or sent", async () => {
  const { server, host, window, id, started } = await runningSession()
  await host.host.sessions.sendFromKettu(id, 'Your step is not reported yet.')
  await host.host.sessions.sendFromKettu(id, 'Your step was sent back.')
  await vi.waitFor(() => expect(window.thread(id).session.queue).toHaveLength(2))
  const queue = window.thread(id).session.queue
  expect(queue.map((item) => item.kettu)).toEqual([true, true])
  await window.request('sessions.steer', { sessionId: id, itemId: queue[0]!.id })
  server.notify('turn/completed', {
    threadId: started.threadId,
    turn: turn(started.turnId!, 'completed'),
  })

  const text = (entry: ThreadEntry) =>
    entry.kind === 'user' && entry.content[0]?.type === 'text' ? entry.content[0].text : null
  await window.untilEntry(id, (entry) => text(entry) === 'Your step was sent back.')
  const users = window.entries(id).filter((entry) => entry.kind === 'user')
  expect(users.map((entry) => [text(entry), entry.kettu])).toEqual([
    [PROMPT, undefined],
    ['Your step is not reported yet.', true],
    ['Your step was sent back.', true],
  ])
})
