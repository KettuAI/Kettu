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

const REVIEWED_WORKFLOW = `format: 1
name: Reviewed step
steps:
  - id: work
    name: Work
    you_review: true
    prompt: Do the work.
    outcomes:
      - name: Done
        end: done
`

/** Starts a Codex workflow task whose first round reports and awaits user review (ready to send back into round 2). */
async function reviewedWorkflowStep() {
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
    name: 'reviewed-step.yaml',
    text: REVIEWED_WORKFLOW,
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
  const round1 = view.rounds[0]!
  const sessionId = round1.sessionId!
  await window.open(sessionId)

  // Step reports round 1 while keeping turn 1 open (e.g. before ending or calling clock.sleep).
  const reported = await host.host.tasks.report(sessionId, {
    outcome: 'Done',
    note: 'First pass complete.',
    artifactId: null,
  })
  expect(reported.accepted).toBe(true)
  expect(reported.next).toEqual({ kind: 'review' })
  return { server, host, window, taskId: task.id, round1Id: round1.id, sessionId, turns }
}

it('wakes a reused workflow step session blocked in native sleep instead of deadlocking in queue', async () => {
  const native = await reviewedWorkflowStep()
  native.server.notify('item/started', {
    threadId: native.turns[0]!.threadId,
    turnId: native.turns[0]!.turnId,
    item: { type: 'sleep', id: 'sleep-1', durationMs: 300_000 },
  })
  await new Promise((resolve) => setTimeout(resolve, 20))

  await native.window.request('tasks.review', {
    taskId: native.taskId,
    roundId: native.round1Id,
    approve: false,
    note: 'Please address the edge case.',
  })

  await vi.waitFor(() => expect(native.server.sent('turn/steer')).toHaveLength(1))
  const nativeSteered = (native.server.sent('turn/steer')[0]!.input as { text?: string }[])[0]?.text
  expect(nativeSteered).toContain('starts again (round 2)')
  expect(nativeSteered).toContain('Please address the edge case.')
  await vi.waitFor(() =>
    expect(native.window.thread(native.sessionId).session.queue).toHaveLength(0),
  )

  const nativeView = await native.window.request('tasks.get', { taskId: native.taskId })
  expect(nativeView.rounds[1]).toMatchObject({
    n: 2,
    state: 'working',
    sessionId: native.sessionId,
  })
  expect(nativeView.steps[0]!.state).toBe('running')

  const nativeR2 = await native.host.host.tasks.report(native.sessionId, {
    outcome: 'Done',
    note: 'Edge case fixed.',
    artifactId: null,
  })
  expect(nativeR2.accepted).toBe(true)
})

it('wakes a reused workflow step session blocked in MCP clock.sleep instead of deadlocking in queue', async () => {
  const mcp = await reviewedWorkflowStep()
  mcp.server.notify('item/started', {
    threadId: mcp.turns[0]!.threadId,
    turnId: mcp.turns[0]!.turnId,
    item: {
      type: 'mcpToolCall',
      id: 'mcp-clock-sleep',
      server: 'clock',
      tool: 'sleep',
      status: 'inProgress',
      arguments: { durationMs: 300_000 },
      result: null,
      error: null,
    },
  })
  await mcp.window.untilEntry(
    mcp.sessionId,
    (e) => e.kind === 'tool' && e.status === 'in_progress' && /clock.*sleep/i.test(e.title),
  )

  await mcp.window.request('tasks.review', {
    taskId: mcp.taskId,
    roundId: mcp.round1Id,
    approve: false,
    note: 'Add a regression test.',
  })

  await vi.waitFor(() => expect(mcp.server.sent('turn/steer')).toHaveLength(1))
  const mcpSteered = (mcp.server.sent('turn/steer')[0]!.input as { text?: string }[])[0]?.text
  expect(mcpSteered).toContain('starts again (round 2)')
  await vi.waitFor(() => expect(mcp.window.thread(mcp.sessionId).session.queue).toHaveLength(0))
  const mcpView = await mcp.window.request('tasks.get', { taskId: mcp.taskId })
  expect(mcpView.rounds[1]).toMatchObject({ n: 2, state: 'working', sessionId: mcp.sessionId })
})

it('delivers directly without steering when reusing an idle step session', async () => {
  const idle = await reviewedWorkflowStep()
  idle.server.notify('turn/completed', {
    threadId: idle.turns[0]!.threadId,
    turn: turn(idle.turns[0]!.turnId, 'completed'),
  })
  await idle.window.untilStatus(idle.sessionId, 'ready')

  await idle.window.request('tasks.review', {
    taskId: idle.taskId,
    roundId: idle.round1Id,
    approve: false,
    note: 'Update docs too.',
  })

  await vi.waitFor(() => expect(idle.turns).toHaveLength(2))
  expect(idle.turns[1]!.text).toContain('starts again (round 2)')
  expect(idle.server.sent('turn/steer')).toHaveLength(0)
  const view = await idle.window.request('tasks.get', { taskId: idle.taskId })
  expect(view.rounds[1]).toMatchObject({ n: 2, state: 'working', sessionId: idle.sessionId })
})

it('queues without interrupting real non-sleep work, keeps round queued, and delivers cleanly on turn end', async () => {
  const busy = await reviewedWorkflowStep()
  busy.server.notify('item/started', {
    threadId: busy.turns[0]!.threadId,
    turnId: busy.turns[0]!.turnId,
    item: {
      type: 'commandExecution',
      id: 'cmd-1',
      command: 'pnpm test',
      cwd: busy.host.project,
      status: 'inProgress',
      commandActions: [{ type: 'unknown', command: 'pnpm test' }],
      aggregatedOutput: null,
      exitCode: null,
    },
  })
  await busy.window.untilEntry(
    busy.sessionId,
    (e) => e.kind === 'tool' && e.status === 'in_progress' && e.title === 'pnpm test',
  )

  await busy.window.request('tasks.review', {
    taskId: busy.taskId,
    roundId: busy.round1Id,
    approve: false,
    note: 'Refactor helper.',
  })

  await vi.waitFor(() => expect(busy.window.thread(busy.sessionId).session.queue).toHaveLength(1))
  expect(busy.server.sent('turn/steer')).toHaveLength(0)
  expect(busy.server.sent('turn/interrupt')).toHaveLength(0)

  const queuedView = await busy.window.request('tasks.get', { taskId: busy.taskId })
  expect(queuedView.rounds[1]).toMatchObject({
    n: 2,
    state: 'queued',
    startedAt: null,
    sessionId: busy.sessionId,
  })
  expect(queuedView.steps[0]!.state).toBe('waiting')

  // Completing the prior turn drains round 2 cleanly with no spurious report reminder.
  busy.server.notify('item/completed', {
    threadId: busy.turns[0]!.threadId,
    turnId: busy.turns[0]!.turnId,
    item: {
      type: 'commandExecution',
      id: 'cmd-1',
      command: 'pnpm test',
      cwd: busy.host.project,
      status: 'completed',
      commandActions: [{ type: 'unknown', command: 'pnpm test' }],
      aggregatedOutput: 'ok',
      exitCode: 0,
    },
  })
  busy.server.notify('turn/completed', {
    threadId: busy.turns[0]!.threadId,
    turn: turn(busy.turns[0]!.turnId, 'completed'),
  })

  await vi.waitFor(() => expect(busy.turns).toHaveLength(2))
  expect(busy.turns[1]!.text).toContain('starts again (round 2)')
  await vi.waitFor(() => expect(busy.window.thread(busy.sessionId).session.queue).toHaveLength(0))
  await vi.waitFor(async () =>
    expect(
      (await busy.window.request('tasks.get', { taskId: busy.taskId })).rounds[1],
    ).toMatchObject({ n: 2, state: 'working' }),
  )
})

it('wakes a queued reused round when non-sleep work finishes and the turn enters clock.sleep', async () => {
  const delayed = await reviewedWorkflowStep()
  delayed.server.notify('item/started', {
    threadId: delayed.turns[0]!.threadId,
    turnId: delayed.turns[0]!.turnId,
    item: {
      type: 'commandExecution',
      id: 'cmd-2',
      command: 'pnpm build',
      cwd: delayed.host.project,
      status: 'inProgress',
      commandActions: [{ type: 'unknown', command: 'pnpm build' }],
      aggregatedOutput: null,
      exitCode: null,
    },
  })
  await delayed.window.untilEntry(
    delayed.sessionId,
    (e) => e.kind === 'tool' && e.status === 'in_progress' && e.title === 'pnpm build',
  )

  await delayed.window.request('tasks.review', {
    taskId: delayed.taskId,
    roundId: delayed.round1Id,
    approve: false,
    note: 'Polish error message.',
  })
  await vi.waitFor(() =>
    expect(delayed.window.thread(delayed.sessionId).session.queue).toHaveLength(1),
  )
  expect(delayed.server.sent('turn/steer')).toHaveLength(0)

  // Non-sleep tool completes, then the agent enters sleep instead of ending the turn.
  delayed.server.notify('item/completed', {
    threadId: delayed.turns[0]!.threadId,
    turnId: delayed.turns[0]!.turnId,
    item: {
      type: 'commandExecution',
      id: 'cmd-2',
      command: 'pnpm build',
      cwd: delayed.host.project,
      status: 'completed',
      commandActions: [{ type: 'unknown', command: 'pnpm build' }],
      aggregatedOutput: 'built',
      exitCode: 0,
    },
  })
  delayed.server.notify('item/started', {
    threadId: delayed.turns[0]!.threadId,
    turnId: delayed.turns[0]!.turnId,
    item: { type: 'sleep', id: 'sleep-later', durationMs: 300_000 },
  })

  await vi.waitFor(() => expect(delayed.server.sent('turn/steer')).toHaveLength(1))
  await vi.waitFor(() =>
    expect(delayed.window.thread(delayed.sessionId).session.queue).toHaveLength(0),
  )
  await vi.waitFor(async () =>
    expect(
      (await delayed.window.request('tasks.get', { taskId: delayed.taskId })).rounds[1],
    ).toMatchObject({ n: 2, state: 'working' }),
  )
})

it('does not bypass an open blocking permission/question card even when sleep is active, then wakes once answered', async () => {
  const gated = await reviewedWorkflowStep()
  gated.server.notify('item/started', {
    threadId: gated.turns[0]!.threadId,
    turnId: gated.turns[0]!.turnId,
    item: { type: 'sleep', id: 'sleep-gated', durationMs: 300_000 },
  })
  const asked = gated.server.request('item/tool/requestUserInput', {
    threadId: gated.turns[0]!.threadId,
    turnId: gated.turns[0]!.turnId,
    itemId: 'ask-gated',
    questions: [
      {
        id: 'q',
        header: 'Confirm',
        question: 'Proceed?',
        isOther: false,
        isSecret: false,
        options: [
          { label: 'Yes', description: '' },
          { label: 'No', description: '' },
        ],
      },
    ],
  })
  await gated.window.untilStatus(gated.sessionId, 'awaiting_permission')

  await gated.window.request('tasks.review', {
    taskId: gated.taskId,
    roundId: gated.round1Id,
    approve: false,
    note: 'Retry step.',
  })

  await vi.waitFor(() => expect(gated.window.thread(gated.sessionId).session.queue).toHaveLength(1))
  expect(gated.server.sent('turn/steer')).toHaveLength(0)
  const queuedView = await gated.window.request('tasks.get', { taskId: gated.taskId })
  expect(queuedView.rounds[1]).toMatchObject({ n: 2, state: 'queued', startedAt: null })
  expect(queuedView.steps[0]!.state).toBe('waiting')

  // Answering the blocking card returns the session to running (still in sleep), which then wakes round 2.
  const ask = gated.window.entries(gated.sessionId).find((e) => e.kind === 'tool' && e.permission)
  const requestId = ask?.kind === 'tool' ? ask.permission!.requestId : ''
  await gated.window.request('permissions.respond', {
    sessionId: gated.sessionId,
    requestId,
    answers: [{ question: 0, choices: [0] }],
  })
  await expect(asked.answer).resolves.toEqual({ answers: { q: { answers: ['Yes'] } } })

  await vi.waitFor(() => expect(gated.server.sent('turn/steer')).toHaveLength(1))
  await vi.waitFor(() => expect(gated.window.thread(gated.sessionId).session.queue).toHaveLength(0))
  await vi.waitFor(async () =>
    expect(
      (await gated.window.request('tasks.get', { taskId: gated.taskId })).rounds[1],
    ).toMatchObject({ n: 2, state: 'working' }),
  )
})
