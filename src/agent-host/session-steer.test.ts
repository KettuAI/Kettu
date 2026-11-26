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

it('withdraws leftover non-blocking requests and releases the waiting state', async () => {
  const { server, host, window, id, started } = await (async () => {
    const base = await runningSession()
    base.server.notify('item/completed', {
      ...base.started,
      item: {
        type: 'agentMessage',
        id: 'call-withdraw',
        text: 'Proceed?',
        phase: 'final_answer',
        delivery: 'async',
        questions: [{ title: 'Proceed?', options: ['Yes', 'No'] }],
      },
    })
    await base.window.untilEntry(
      base.id,
      (entry) => entry.kind === 'tool' && entry.permission !== null,
    )
    return base
  })()

  // Turn completes while the non-blocking question stays open and keeps the session waiting.
  server.notify('turn/completed', {
    threadId: started.threadId,
    turn: turn(started.turnId!, 'completed'),
  })
  await window.untilStatus(id, 'ready')
  expect(window.summary(id)?.permissionCount).toBe(1)

  const ask = window.entries(id).find((entry) => entry.kind === 'tool' && entry.permission)
  const requestId = ask?.kind === 'tool' ? ask.permission!.requestId : ''
  host.host.sessions.withdrawPending(id)

  await window.until(() => window.summary(id)?.permissionCount === 0)
  const settled = window.entries(id).find((entry) => entry.id === ask?.id)
  expect(settled).toMatchObject({ permission: null, permissionResult: 'withdrawn' })
  // A late click on the withdrawn card is rejected and cannot wake the session.
  await expect(
    window.request('permissions.respond', {
      sessionId: id,
      requestId,
      answers: [{ question: 0, choices: [0] }],
    }),
  ).rejects.toThrow()
  expect(server.sent('turn/start').filter((p) => p.threadId === started.threadId)).toHaveLength(1)
})

const ONE_STEP_WORKFLOW = `format: 1
name: One step
steps:
  - id: work
    name: Work
    prompt: Do the work.
    outcomes:
      - name: Done
        end: done
`

/** Starts a single-step Codex workflow task whose first turn asks a non-blocking question. */
async function workflowAsyncQuestion(itemId: string) {
  const server = new FakeAppServer()
  const turns: { threadId: string; turnId: string; text: string }[] = []
  server.on('turn/start', (params, self) => {
    const turnId = self.nextTurnId()
    const input = params.input as { text?: string }[]
    const text = input[0]?.text ?? ''
    if (text.includes('Do the work.') || turns.some((t) => t.threadId === params.threadId)) {
      turns.push({ threadId: params.threadId as string, turnId, text })
    }
    return { turn: turn(turnId) }
  })
  const host = await startTestHost({ fakeAppServer: server })
  hosts.push(host)
  const window = host.connect()
  const entry = await window.request('workflows.add', {
    kind: 'file',
    name: 'one-step.yaml',
    text: ONE_STEP_WORKFLOW,
  })
  await window.request('workflows.approve', { workflowId: entry.id, hash: entry.hash })
  const task = await window.request('tasks.start', {
    projectPath: host.project,
    workflowId: entry.id,
    text: 'Ship the fix',
    pace: 'balanced',
    agentId: 'codex',
    options: {},
  })
  await vi.waitFor(() => expect(turns).toHaveLength(1))
  const view = await window.request('tasks.get', { taskId: task.id })
  const sessionId = view.rounds[0]!.sessionId!
  await window.open(sessionId)

  const first = turns[0]!
  server.notify('item/completed', {
    threadId: first.threadId,
    turnId: first.turnId,
    item: {
      type: 'agentMessage',
      id: itemId,
      text: 'Which target?',
      phase: 'final_answer',
      delivery: 'async',
      questions: [{ title: 'Which target?', options: ['Staging', 'Production'] }],
    },
  })
  await window.untilEntry(sessionId, (e) => e.kind === 'tool' && e.permission !== null)
  await vi.waitFor(async () =>
    expect((await window.request('tasks.get', { taskId: task.id })).rounds[0]!.asking).toBe(true),
  )
  const ask = window.entries(sessionId).find((e) => e.kind === 'tool' && e.permission)
  const requestId = ask?.kind === 'tool' ? ask.permission!.requestId : ''
  return { server, host, window, taskId: task.id, sessionId, turns, requestId, askId: ask!.id }
}

it('gates report_step, pauses reminders while asking, and resumes cleanly on answer or skip', async () => {
  // 1. Answering after turn end starts the reply turn with no spurious reminder and keeps
  //    step-report tracking active for that reply turn.
  const answered = await workflowAsyncQuestion('wf-q-answer')
  const refused = await answered.host.host.tasks.report(answered.sessionId, {
    outcome: 'Done',
    note: 'Tried too early',
    artifactId: null,
  })
  expect(refused.accepted).toBe(false)
  expect(refused.checks).toContainEqual({
    check: 'answered',
    ok: false,
    detail: expect.stringContaining('report_step'),
  })

  // Turn ends while waiting for the user's answer: no reminder sent, task shows asking.
  answered.server.notify('turn/completed', {
    threadId: answered.turns[0]!.threadId,
    turn: turn(answered.turns[0]!.turnId, 'completed'),
  })
  await answered.window.untilStatus(answered.sessionId, 'ready')
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(answered.turns).toHaveLength(1)
  expect((await answered.window.request('tasks.get', { taskId: answered.taskId })).needs).toEqual([
    expect.objectContaining({ kind: 'asking', stepId: 'work', sessionId: answered.sessionId }),
  ])

  // User answers the async question: reply starts turn 2 without any spurious reminder.
  await answered.window.request('permissions.respond', {
    sessionId: answered.sessionId,
    requestId: answered.requestId,
    answers: [{ question: 0, choices: [0] }],
  })
  await vi.waitFor(() => expect(answered.turns).toHaveLength(2))
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(answered.turns).toHaveLength(2)
  expect(answered.turns[1]!.text).toContain('<send_user_message_question_reply>')
  expect(answered.turns[1]!.text).toContain('"answer":"Staging"')

  // If the reply turn ends without reporting, the engine still reminds (not treated as user chat).
  answered.server.notify('turn/completed', {
    threadId: answered.turns[1]!.threadId,
    turn: turn(answered.turns[1]!.turnId, 'completed'),
  })
  await vi.waitFor(() => expect(answered.turns).toHaveLength(3))
  expect(answered.turns[2]!.text).toContain('report_step')

  const ok = await answered.host.host.tasks.report(answered.sessionId, {
    outcome: 'Done',
    note: 'Deployed to staging.',
    artifactId: null,
  })
  expect(ok.accepted).toBe(true)
  expect((await answered.window.request('tasks.get', { taskId: answered.taskId })).status).toBe(
    'done',
  )

  // 2. Skipping an async question while idle wakes the step instead of hanging silently.
  const skipped = await workflowAsyncQuestion('wf-q-skip')
  skipped.server.notify('turn/completed', {
    threadId: skipped.turns[0]!.threadId,
    turn: turn(skipped.turns[0]!.turnId, 'completed'),
  })
  await skipped.window.untilStatus(skipped.sessionId, 'ready')
  await skipped.window.request('permissions.respond', {
    sessionId: skipped.sessionId,
    requestId: skipped.requestId,
    answers: [],
  })
  await vi.waitFor(() => expect(skipped.turns).toHaveLength(2))
  expect(skipped.turns[1]!.text).toContain('report_step')

  // 3. Cancelling a task while idle on an async question withdraws the card, releases waiting,
  //    never fires a reminder, and rejects a late click.
  const cancelled = await workflowAsyncQuestion('wf-q-cancel')
  cancelled.server.notify('turn/completed', {
    threadId: cancelled.turns[0]!.threadId,
    turn: turn(cancelled.turns[0]!.turnId, 'completed'),
  })
  await cancelled.window.untilStatus(cancelled.sessionId, 'ready')
  await cancelled.window.request('tasks.cancel', { taskId: cancelled.taskId })
  await cancelled.window.until(
    () => cancelled.window.summary(cancelled.sessionId)?.permissionCount === 0,
  )
  const card = cancelled.window.entries(cancelled.sessionId).find((e) => e.id === cancelled.askId)
  expect(card).toMatchObject({ permission: null, permissionResult: 'withdrawn' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(cancelled.turns).toHaveLength(1)
  await expect(
    cancelled.window.request('permissions.respond', {
      sessionId: cancelled.sessionId,
      requestId: cancelled.requestId,
      answers: [{ question: 0, choices: [1] }],
    }),
  ).rejects.toThrow()
})
