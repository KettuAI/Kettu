// agy 1.5.15's sub-agents over ACP: a child agy's store lists under the session that started it,
// shown as a sub-agent and opened in the parent's process, its updates in its own thread and its
// questions in its own card; a session's replay shows its children again.

import {
  agent,
  methods,
  type AgentContext,
  type CreateElicitationResponse,
  type SessionUpdate,
} from '@agentclientprotocol/sdk/unstable'
import { describe, expect, it, vi } from 'vitest'
import {
  applyPatches,
  threadEntries,
  threadFromSnapshot,
  type ThreadEntry,
  type ThreadState,
} from '@shared/thread'
import type {
  ConnectionHooks,
  McpServer,
  PermissionAnswer,
  PermissionRequest,
  SessionTarget,
} from '../connection'
import { newTurnScope, type MapperEffect } from '../session-updates'
import { AgySubagents, type AgyChild } from './agy-subagents'
import { AcpConnection, inProcessTransport } from './connection'

const PARENT = 's-1'
const CHILD = 'c-1'
const GRANDCHILD = 'g-1'
const CWD = '/tmp/agy-probe'
const PROMPT = 'Ask the user to pick a letter, A or B, then report the letter back.'
const RUNNING = 'CASCADE_RUN_STATUS_RUNNING'
const IDLE = 'CASCADE_RUN_STATUS_IDLE'
const SERVERS: McpServer[] = [
  { type: 'http', name: 'kettu', url: 'http://127.0.0.1:1/mcp', headers: [] },
]

// The calls as agy 1.5.15 sent them.
const START = {
  toolCallId: 'call_start',
  name: 'invoke_subagent',
  kind: 'other',
  title: 'Run invoke_subagent',
  rawInput: { Prompt: PROMPT, Role: 'Asker', TypeName: 'self', Model: 'inherit' },
}
const ASK = {
  toolCallId: 'call_ask',
  name: 'ask_question',
  kind: 'other',
  title: 'Run ask_question',
  rawInput: {
    questions: [{ is_multi_select: false, options: ['A', 'B'], question: 'Pick a letter' }],
  },
}
const REPORT = {
  toolCallId: 'call_report',
  name: 'send_message',
  kind: 'other',
  title: 'Run send_message',
  rawInput: { Message: 'The user picked B', Recipient: PARENT },
}
const SCHEMA = {
  type: 'object',
  properties: {
    q1: {
      type: 'string',
      title: 'Pick a letter',
      oneOf: [
        { const: '1', title: 'A' },
        { const: '2', title: 'B' },
      ],
    },
    q1_other: {
      type: 'string',
      title: 'Other',
      description: 'Optional free-form answer to: Pick a letter',
    },
  },
}

const child = (id: string, parentId: string, status: string, agent = 'self'): AgyChild => ({
  id,
  parentId,
  status,
  killed: false,
  agent,
  title: '',
})

const update = (sessionId: string, value: object) => ({
  sessionId,
  update: value as SessionUpdate,
})

const AGAIN = {
  toolCallId: 'call_again',
  name: 'send_message',
  kind: 'other',
  title: 'Run send_message',
  rawInput: { Message: 'Ask once more.', Recipient: CHILD },
}

/**
 * A fake agy whose turn starts one sub-agent, or with `again` messages the one it has, and waits
 * for its report, as 1.5.15 does: the child asks its question only once a `session/load` opened
 * it, and reports once it is answered.
 */
function connect(version: string, again = false) {
  const rows: AgyChild[] = []
  const reads: string[][] = []
  const loads: Record<string, unknown>[] = []
  const answers: CreateElicitationResponse[] = []
  let reported: (() => void) | null = null

  const askAndReport = async (client: AgentContext) => {
    const answer = await client.request(methods.client.elicitation.create, {
      sessionId: CHILD,
      toolCallId: ASK.toolCallId,
      mode: 'form',
      message: 'The agent has a question.',
      requestedSchema: SCHEMA,
    } as never)
    answers.push(answer)
    const send = (value: object) =>
      client.notify(methods.client.session.update, update(CHILD, value))
    await send({ sessionUpdate: 'tool_call_update', ...ASK, status: 'completed' })
    await send({ sessionUpdate: 'tool_call', ...REPORT, status: 'completed' })
    await send({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Reported B to the caller.' },
    })
    rows[0]!.status = IDLE
    reported?.()
  }

  const app = agent({ name: 'agy-test' })
    .onRequest(methods.agent.initialize, () => ({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, sessionCapabilities: { close: {}, load: {} } },
      agentInfo: { name: 'Antigravity ACP Server', version },
      authMethods: [],
    }))
    .onRequest(methods.agent.session.new, () => ({ sessionId: PARENT }))
    .onRequest(methods.agent.session.resume, () => ({}))
    .onRequest(methods.agent.session.load, async (ctx) => {
      const { sessionId } = ctx.params
      loads.push(ctx.params as unknown as Record<string, unknown>)
      const send = (value: object) =>
        ctx.client.notify(methods.client.session.update, update(sessionId, value))
      if (sessionId === PARENT) {
        await send({ sessionUpdate: 'tool_call', ...START, status: 'completed' })
        return {}
      }
      // What the child did so far, before the answer, as agy replays it.
      await send({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'Asking for a letter.' },
      })
      if (rows.find((row) => row.id === sessionId)?.status === RUNNING) {
        await send({ sessionUpdate: 'tool_call', ...ASK, status: 'pending' })
        setTimeout(() => void askAndReport(ctx.client), 10)
      } else {
        await send({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `Done in ${sessionId}.` },
        })
      }
      return {}
    })
    .onRequest(methods.agent.session.prompt, async (ctx) => {
      const send = (value: object) =>
        ctx.client.notify(methods.client.session.update, update(PARENT, value))
      const call = again ? AGAIN : START
      await send({ sessionUpdate: 'tool_call', ...call, status: 'in_progress' })
      await send({ sessionUpdate: 'tool_call_update', ...call, status: 'completed' })
      const done = new Promise<void>((resolve) => (reported = resolve))
      if (again) rows[0]!.status = RUNNING
      else rows.push(child(CHILD, PARENT, RUNNING))
      // agy holds the turn until the child reports back.
      await done
      await send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'B' } })
      return { stopReason: 'end_turn' }
    })
  const hooks: ConnectionHooks = {
    traffic: () => {},
    account: () => {},
    ignored: () => {},
    log: () => {},
  }
  const connection = AcpConnection.connect(inProcessTransport(app), {
    ...hooks,
    agentId: 'antigravity',
    name: 'Google Antigravity',
    agyStore: async (parents) => {
      reads.push([...parents])
      return rows.filter((row) => parents.includes(row.parentId)).map((row) => ({ ...row }))
    },
  })
  return { connection, rows, reads, loads, answers }
}

interface Session {
  target: SessionTarget
  effects: MapperEffect[]
  requests: PermissionRequest[]
  entries(): ThreadEntry[]
  replaying: boolean
}

/**
 * A session's thread, which opens a sub-agent's thread on the connection as the host does when it
 * shows one, and answers every question with B.
 */
function sessions(connection: AcpConnection) {
  const byId = new Map<string, Session>()
  const open = (acpSessionId: string): Session => {
    let thread: ThreadState = threadFromSnapshot({
      session: {
        id: `k-${acpSessionId}`,
        agentId: 'antigravity',
        projectPath: CWD,
        acpSessionId,
        status: 'running',
        title: null,
        config: [],
        commands: [],
        usage: null,
        error: null,
        turnStartedAt: null,
        turnStartUsed: null,
        createdAt: 0,
        updatedAt: 0,
        parentId: null,
        origin: 'user',
        subagent: null,
        routine: null,
        queue: [],
        queuePaused: false,
      },
      entries: [],
      seq: 0,
    })
    let n = 0
    const scope = newTurnScope()
    const session: Session = {
      effects: [],
      requests: [],
      entries: () => threadEntries(thread),
      replaying: false,
      target: {
        context: () => ({
          thread,
          replaying: session.replaying,
          cancelling: false,
          scope,
          now: 5_000,
          nextId: () => `e:${++n}`,
          sessionIdFor: (id) => `k-${id}`,
        }),
        apply: (output) => {
          thread = applyPatches(thread, output.patches)
          for (const effect of output.effects) {
            session.effects.push(effect)
            if (effect.kind === 'subagent' && !byId.has(effect.sessionId)) {
              open(effect.sessionId).replaying = session.replaying
            }
          }
        },
        requestPermission: async (request): Promise<PermissionAnswer> => {
          session.requests.push(request)
          session.target.apply(request.output)
          return { answers: [{ question: 0, choices: [1] }] }
        },
        send: () => {},
        startMode: () => null,
      },
    }
    byId.set(acpSessionId, session)
    connection.register(acpSessionId, session.target)
    return session
  }
  return { open, get: (id: string) => byId.get(id) }
}

const subagentEffects = (session: Session) =>
  session.effects.filter((effect) => effect.kind === 'subagent')

describe("agy's sub-agents", () => {
  it("open a running child in its parent's process, with its updates and questions in its thread", async () => {
    const { connection, loads, answers, reads } = connect('1.5.15')
    await connection.initialize('1.0.0')
    await connection.newSession(CWD, { mcpServers: SERVERS })
    const shown = sessions(connection)
    const parent = shown.open(PARENT)

    // The turn ends only because the child's question was answered.
    await connection.prompt(PARENT, [{ type: 'text', text: 'start a sub-agent that asks me' }])

    expect(subagentEffects(parent)[0]).toEqual({
      kind: 'subagent',
      sessionId: CHILD,
      title: 'Asker',
      description: PROMPT,
      canCancel: false,
      state: { kind: 'running' },
    })
    expect(reads[0]).toEqual([PARENT])
    expect(loads).toEqual([
      {
        sessionId: CHILD,
        cwd: CWD,
        mcpServers: [{ type: 'http', name: 'kettu', url: 'http://127.0.0.1:1/mcp', headers: [] }],
        _meta: { 'sh.kettu/parent-session': PARENT },
      },
    ])
    const sub = shown.get(CHILD)!
    expect(sub.requests.map((request) => request.questions?.map((q) => q.question))).toEqual([
      ['Pick a letter'],
    ])
    expect(answers).toEqual([{ action: 'accept', content: { q1: '2' } }])
    const entries = sub.entries()
    // What the parent asked of it comes first, from the parent.
    expect(entries[0]).toEqual({
      kind: 'session_message',
      id: 'sm:call_start',
      senderId: `k-${PARENT}`,
      content: [{ type: 'text', text: PROMPT }],
    })
    expect(entries.find((entry) => entry.id === 't:call_ask')).toMatchObject({
      title: 'Pick a letter',
      status: 'completed',
    })
    expect(entries.some((entry) => entry.kind === 'agent')).toBe(true)
    // Nothing of the child went into the parent's thread.
    expect(parent.entries().some((entry) => entry.id === 't:call_ask')).toBe(false)

    // The store's idle ends it.
    await vi.waitFor(
      () =>
        expect(subagentEffects(parent).at(-1)).toEqual({
          kind: 'subagent',
          sessionId: CHILD,
          state: { kind: 'idle', stopReason: 'end_turn', error: null, tokens: null },
        }),
      { timeout: 3_000 },
    )
    connection.close()
  })

  it("show a session's children and theirs again as it is replayed, before its load answers", async () => {
    const { connection, rows, loads } = connect('1.5.15')
    rows.push(child(CHILD, PARENT, IDLE), child(GRANDCHILD, CHILD, IDLE, 'teamwork_interviewer'))
    await connection.initialize('1.0.0')
    const shown = sessions(connection)
    const parent = shown.open(PARENT)
    parent.replaying = true
    await connection.loadSession(PARENT, CWD, { mcpServers: SERVERS })

    expect(loads.map((load) => [load.sessionId, load._meta])).toEqual([
      [PARENT, undefined],
      [CHILD, { 'sh.kettu/parent-session': PARENT }],
      [GRANDCHILD, { 'sh.kettu/parent-session': CHILD }],
    ])
    expect(subagentEffects(parent)).toEqual([
      {
        kind: 'subagent',
        sessionId: CHILD,
        title: 'Asker',
        description: PROMPT,
        canCancel: false,
        state: { kind: 'idle', stopReason: 'end_turn', error: null, tokens: null },
      },
    ])
    const sub = shown.get(CHILD)!
    // A child started without a call Kettu saw is named by its type, with no task.
    expect(subagentEffects(sub)).toEqual([
      {
        kind: 'subagent',
        sessionId: GRANDCHILD,
        title: 'teamwork_interviewer',
        canCancel: false,
        state: { kind: 'idle', stopReason: 'end_turn', error: null, tokens: null },
      },
    ])
    expect(sub.entries().map((entry) => entry.kind)).toEqual([
      'session_message',
      'thought',
      'agent',
    ])
    expect(
      shown
        .get(GRANDCHILD)!
        .entries()
        .map((entry) => entry.kind),
    ).toEqual(['thought', 'agent'])
    connection.close()
  })

  it('carry on a child Kettu kept from before its parent was let go, without replaying it', async () => {
    const { connection, rows, loads, answers } = connect('1.5.15', true)
    rows.push(child(CHILD, PARENT, IDLE))
    await connection.initialize('1.0.0')
    await connection.resumeSession(PARENT, CWD, { mcpServers: SERVERS })
    const shown = sessions(connection)
    const parent = shown.open(PARENT)
    const kept = shown.open(CHILD)
    kept.target.apply({
      patches: [
        {
          op: 'entry.add',
          entry: {
            kind: 'agent',
            id: 'm:earlier',
            markdown: 'Reported A to the caller.',
            attachments: [],
            streaming: false,
          },
        },
      ],
      effects: [],
    })

    await connection.prompt(PARENT, [{ type: 'text', text: 'ask the same sub-agent again' }])

    // Its name and task are not cleared by a child the turn did not start.
    expect(subagentEffects(parent)[0]).toEqual({
      kind: 'subagent',
      sessionId: CHILD,
      canCancel: false,
      state: { kind: 'running' },
    })
    expect(loads.map((load) => load.sessionId)).toEqual([CHILD])
    expect(answers).toEqual([{ action: 'accept', content: { q1: '2' } }])
    const texts = kept
      .entries()
      .map((entry) =>
        entry.kind === 'agent' || entry.kind === 'thought'
          ? entry.markdown
          : entry.kind === 'tool'
            ? entry.title
            : entry.kind,
      )
    // What agy replays as it opens the child again is not added twice.
    expect(texts).not.toContain('Asking for a letter.')
    expect(texts).toEqual([
      'Reported A to the caller.',
      'Pick a letter',
      'Run send_message',
      'Reported B to the caller.',
    ])
    connection.close()
  })

  it('are not followed on a version they were not measured on', async () => {
    const { connection, reads, rows } = connect('1.5.14')
    await connection.initialize('1.0.0')
    await connection.newSession(CWD)
    const parent = sessions(connection).open(PARENT)
    const turn = connection.prompt(PARENT, [{ type: 'text', text: 'start a sub-agent' }])
    await vi.waitFor(() => expect(rows).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(reads).toEqual([])
    expect(subagentEffects(parent)).toEqual([])
    connection.close()
    await turn.catch(() => {})
  })

  it('settles a running child on a non-idle terminal status or when its row disappears', async () => {
    const rows: AgyChild[] = [child(CHILD, PARENT, RUNNING)]
    const settled: string[] = []
    const states: string[] = []
    const makeTarget = (): SessionTarget => ({
      context: () => ({
        thread: threadFromSnapshot({
          session: {
            id: `k-${PARENT}`,
            agentId: 'antigravity',
            projectPath: CWD,
            acpSessionId: PARENT,
            status: 'running',
            title: null,
            config: [],
            commands: [],
            usage: null,
            error: null,
            turnStartedAt: null,
            turnStartUsed: null,
            createdAt: 0,
            updatedAt: 0,
            parentId: null,
            origin: 'user',
            subagent: null,
            routine: null,
            queue: [],
            queuePaused: false,
          },
          entries: [],
          seq: 0,
        }),
        replaying: false,
        cancelling: false,
        scope: newTurnScope(),
        now: 1,
        nextId: () => 'e:1',
        sessionIdFor: (id) => `k-${id}`,
      }),
      apply: (output) => {
        for (const effect of output.effects) {
          if (effect.kind === 'subagent' && effect.state) states.push(effect.state.kind)
        }
      },
      requestPermission: async () => 'cancelled',
      send: () => {},
      startMode: () => null,
    })
    const parentTarget = makeTarget()
    let prompting = true
    const tracker = new AgySubagents(
      async (parents) =>
        rows.filter((row) => parents.includes(row.parentId)).map((row) => ({ ...row })),
      {
        target: (id) => (id === PARENT ? parentTarget : undefined),
        prompting: (id) => id === PARENT && prompting,
        load: async () => {},
        settled: (id) => settled.push(id),
        log: () => {},
      },
    )

    tracker.noted(
      PARENT,
      { sessionUpdate: 'tool_call', ...START, status: 'in_progress' } as never,
      false,
    )
    await vi.waitFor(() => expect(tracker.running(PARENT)).toBe(true), { timeout: 2_000 })

    // 模拟子智能体进入非 IDLE 的终态（如 ERROR），必须解除 running 并触发 settled。
    rows[0]!.status = 'CASCADE_RUN_STATUS_ERROR'
    await vi.waitFor(() => expect(tracker.running(PARENT)).toBe(false), { timeout: 2_000 })
    expect(settled).toEqual([PARENT])

    // 再次进入运行态后，模拟子智能体记录从数据库中消失，也应解除 running 并触发 settled。
    rows[0]!.status = RUNNING
    tracker.noted(
      PARENT,
      { sessionUpdate: 'tool_call', ...AGAIN, status: 'in_progress' } as never,
      false,
    )
    await vi.waitFor(() => expect(tracker.running(PARENT)).toBe(true), { timeout: 2_000 })
    prompting = false
    rows.length = 0
    await vi.waitFor(() => expect(tracker.running(PARENT)).toBe(false), { timeout: 2_000 })
    expect(settled).toEqual([PARENT, PARENT])
    expect(states).toEqual(['running', 'idle', 'running', 'idle'])
    tracker.stop()
  })
})
