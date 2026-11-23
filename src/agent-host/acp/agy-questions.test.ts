// agy 1.5.15's ask_question over ACP: its form elicitation as Kettu's question card, and the
// answers as the form's content.

import {
  agent,
  methods,
  type AgentContext,
  type ClientCapabilities,
  type CreateElicitationResponse,
  type SessionUpdate,
} from '@agentclientprotocol/sdk/unstable'
import { describe, expect, it } from 'vitest'
import {
  applyPatches,
  threadEntries,
  threadFromSnapshot,
  type PendingQuestion,
  type ThreadState,
  type ToolEntry,
} from '@shared/thread'
import type {
  ConnectionHooks,
  PermissionAnswer,
  PermissionRequest,
  SessionTarget,
} from '../connection'
import { newTurnScope } from '../session-updates'
import { agyAsk, askContent } from './agy-questions'
import { AcpConnection, inProcessTransport } from './connection'

// What agy 1.5.15 sent for two questions, one of a choice and one of several.
const SCHEMA = {
  type: 'object',
  properties: {
    q1: {
      type: 'string',
      title: 'Which color do I prefer?',
      oneOf: [
        { const: '1', title: 'Red' },
        { const: '2', title: 'Blue' },
      ],
    },
    q1_other: {
      type: 'string',
      title: 'Other',
      description: 'Optional free-form answer to: Which color do I prefer?',
    },
    q2: {
      type: 'array',
      title: 'Which fruits do I like?',
      items: {
        anyOf: [
          { const: '1', title: 'Apple' },
          { const: '2', title: 'Pear' },
          { const: '3', title: 'Plum' },
        ],
      },
    },
    q2_other: {
      type: 'string',
      title: 'Other',
      description: 'Optional free-form answer to: Which fruits do I like?',
    },
  },
}

const GAVE_UP = 'The user did not respond to the clarifying questions in time.'

const CALL = {
  toolCallId: 'call_1',
  name: 'ask_question',
  status: 'in_progress',
  kind: 'other',
  title: 'Run ask_question',
  rawInput: {
    questions: [
      { is_multi_select: false, options: ['Red', 'Blue'], question: 'Which color do I prefer?' },
      {
        is_multi_select: true,
        options: ['Apple', 'Pear', 'Plum'],
        question: 'Which fruits do I like?',
      },
    ],
  },
}

describe("agy's ask form", () => {
  it('reads each question with its options, kind of choice and room for words', () => {
    const ask = agyAsk(SCHEMA)
    expect(ask?.questions).toEqual<PendingQuestion[]>([
      {
        header: '',
        question: 'Which color do I prefer?',
        multiSelect: false,
        options: [{ label: 'Red' }, { label: 'Blue' }],
        allowsText: true,
        secret: false,
      },
      {
        header: '',
        question: 'Which fruits do I like?',
        multiSelect: true,
        options: [{ label: 'Apple' }, { label: 'Pear' }, { label: 'Plum' }],
        allowsText: true,
        secret: false,
      },
    ])
  })

  it('takes a question without its own words field, and puts the questions in agy order', () => {
    const { q1, q2 } = SCHEMA.properties
    const ask = agyAsk({ type: 'object', properties: { q2, q1 } })
    expect(ask?.questions.map((q) => [q.question, q.allowsText])).toEqual([
      ['Which color do I prefer?', false],
      ['Which fruits do I like?', false],
    ])
  })

  it('reads no other shape', () => {
    const { q1, q1_other } = SCHEMA.properties
    const form = (properties: Record<string, unknown>, extra: object = {}) => ({
      type: 'object',
      properties,
      ...extra,
    })
    expect(agyAsk(null)).toBe(null)
    expect(agyAsk(form({}))).toBe(null)
    expect(agyAsk(form({ q1, token: { type: 'string', title: 'Token' } }))).toBe(null)
    expect(agyAsk(form({ q1_other }))).toBe(null)
    expect(agyAsk(form({ q1 }, { required: ['q1'] }))).toBe(null)
    expect(agyAsk(form({ q1: { ...q1, oneOf: [] } }))).toBe(null)
    expect(agyAsk(form({ q1: { type: 'string', title: 'Which color do I prefer?' } }))).toBe(null)
    expect(agyAsk(form({ q1: { ...q1, title: undefined } }))).toBe(null)
    expect(
      agyAsk(
        form({
          q1: {
            ...q1,
            oneOf: [
              { const: '1', title: 'A' },
              { const: '1', title: 'B' },
            ],
          },
        }),
      ),
    ).toBe(null)
  })

  it('answers a choice with its value, a list with its values and words in their own field', () => {
    const ask = agyAsk(SCHEMA)!
    expect(
      askContent(ask, [
        { question: 0, choices: [1] },
        { question: 1, choices: [2, 0], text: ' Kiwi ' },
      ]),
    ).toEqual({ q1: '2', q2: ['1', '3'], q2_other: 'Kiwi' })
    expect(askContent(ask, [{ question: 0, choices: [], text: 'Purple' }])).toEqual({
      q1_other: 'Purple',
    })
    expect(askContent(ask, [])).toEqual({})
  })
})

interface Seen {
  capabilities: ClientCapabilities
  responses: CreateElicitationResponse[]
}

/** A fake agy that asks `SCHEMA` for the call `CALL` in its one turn, as 1.5.15 does. */
function connect(
  version: string,
  agentId: 'antigravity' | 'gemini' = 'antigravity',
  { givesUp = false } = {},
) {
  const seen: Seen = { capabilities: {}, responses: [] }
  const turn = async (client: AgentContext, sessionId: string) => {
    const update = (value: object) => ({ sessionId, update: value as SessionUpdate })
    await client.notify(
      methods.client.session.update,
      update({ sessionUpdate: 'tool_call', ...CALL }),
    )
    const asked = client.request(methods.client.elicitation.create, {
      sessionId,
      toolCallId: CALL.toolCallId,
      mode: 'form',
      message: 'The agent has 2 questions.',
      requestedSchema: SCHEMA,
    } as never)
    if (givesUp) {
      // What agy sent when a sub-agent's question was not answered in time: the call failed with
      // its own words, and no cancel of the request.
      const failed = {
        sessionUpdate: 'tool_call_update',
        ...CALL,
        status: 'failed',
        content: [{ type: 'content', content: { type: 'text', text: GAVE_UP } }],
      }
      await client.notify(methods.client.session.update, update(failed))
      seen.responses.push(await asked)
      return
    }
    seen.responses.push(await asked)
    const done = { sessionUpdate: 'tool_call_update', ...CALL, status: 'completed' }
    await client.notify(methods.client.session.update, update(done))
  }
  const app = agent({ name: 'agy-test' })
    .onRequest(methods.agent.initialize, (ctx) => {
      seen.capabilities = ctx.params.clientCapabilities ?? {}
      return {
        protocolVersion: 1,
        agentCapabilities: {},
        agentInfo: { name: 'Antigravity ACP Server', version },
        authMethods: [],
      }
    })
    .onRequest(methods.agent.session.new, () => ({ sessionId: 's-1' }))
    .onRequest(methods.agent.session.prompt, async (ctx) => {
      await turn(ctx.client, ctx.params.sessionId)
      return { stopReason: 'end_turn' }
    })
  const hooks: ConnectionHooks = {
    traffic: () => {},
    account: () => {},
    ignored: () => {},
    log: () => {},
  }
  const connection = AcpConnection.connect(inProcessTransport(app), { ...hooks, agentId })
  return { connection, seen }
}

/** A session whose card is answered by `answer`, recording the requests it was shown. */
function threadTarget(
  answer: (request: PermissionRequest, signal: AbortSignal) => Promise<PermissionAnswer>,
) {
  let thread: ThreadState = threadFromSnapshot({
    session: {
      id: 's',
      agentId: 'antigravity',
      projectPath: '/tmp/agy-probe',
      acpSessionId: 's-1',
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
  const requests: PermissionRequest[] = []
  const target: SessionTarget = {
    context: () => ({
      thread,
      replaying: false,
      cancelling: false,
      scope,
      now: 5_000,
      nextId: () => `e:${++n}`,
      sessionIdFor: () => null,
    }),
    apply: (output) => {
      thread = applyPatches(thread, output.patches)
    },
    requestPermission: async (request, signal) => {
      requests.push(request)
      target.apply(request.output)
      return answer(request, signal)
    },
    send: () => {},
    startMode: () => null,
  }
  return { target, requests, tools: () => threadEntries(thread).filter((e) => e.kind === 'tool') }
}

async function ask(
  version: string,
  answer: (request: PermissionRequest, signal: AbortSignal) => Promise<PermissionAnswer>,
  options: { givesUp?: boolean } = {},
) {
  const { connection, seen } = connect(version, 'antigravity', options)
  await connection.initialize('1.0.0')
  const { sessionId } = await connection.newSession('/tmp/agy-probe')
  const session = threadTarget(answer)
  connection.register(sessionId, session.target)
  await connection.prompt(sessionId, [{ type: 'text', text: 'ask me' }])
  connection.close()
  return { seen, ...session }
}

describe("agy's questions in the question card", () => {
  it('shows the questions and accepts the answers as the form asks for them', async () => {
    const { seen, requests, tools } = await ask('1.5.15', async () => ({
      answers: [
        { question: 0, choices: [1] },
        { question: 1, choices: [0, 2], text: 'Kiwi' },
      ],
    }))
    expect(seen.capabilities.elicitation).toEqual({ form: {}, url: {} })
    expect(requests).toHaveLength(1)
    expect(requests[0]!.toolCallId).toBe('call_1')
    expect(requests[0]!.questions?.map((q) => q.question)).toEqual([
      'Which color do I prefer?',
      'Which fruits do I like?',
    ])
    // A client that shows no questions gets the first one's choices, and Something else.
    expect(requests[0]!.options.map((o) => [o.id, o.kind])).toEqual([
      ['answer:0', 'allow_once'],
      ['answer:1', 'allow_once'],
      ['other', 'reject_once'],
    ])
    expect(requests[0]!.options.slice(0, 2).map((o) => o.name)).toEqual(['Red', 'Blue'])
    expect(seen.responses).toEqual([
      { action: 'accept', content: { q1: '2', q2: ['1', '3'], q2_other: 'Kiwi' } },
    ])
    // One row for the call, titled by its question, whatever agy's updates call it.
    const rows = tools() as ToolEntry[]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      title: 'Which color do I prefer?',
      question: 'Which color do I prefer?',
      toolKind: 'other',
      status: 'completed',
    })
  })

  it('declines when nothing was answered, so agy asks in the chat', async () => {
    const { seen } = await ask('1.5.15', async () => ({ answers: [] }))
    expect(seen.responses).toEqual([{ action: 'decline' }])
  })

  it('answers the first question alone for a client that sends one option', async () => {
    const chosen = await ask('1.5.15', async () => ({ optionId: 'answer:1' }))
    expect(chosen.seen.responses).toEqual([{ action: 'accept', content: { q1: '2' } }])
    const other = await ask('1.5.15', async () => ({ optionId: 'other' }))
    expect(other.seen.responses).toEqual([{ action: 'decline' }])
  })

  it('cancels a request the host cancelled or the agent withdrew', async () => {
    const cancelled = await ask('1.5.15', async () => 'cancelled')
    expect(cancelled.seen.responses).toEqual([{ action: 'cancel' }])
    const withdrawn = await ask('1.5.15', async () => {
      throw new Error('withdrawn')
    })
    expect(withdrawn.seen.responses).toEqual([{ action: 'cancel' }])
  })

  it('withdraws the card once agy ends the call without the answer', async () => {
    let withdrawn = false
    const { seen, tools } = await ask(
      '1.5.15',
      (_request, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            withdrawn = true
            reject(signal.reason)
          })
        }),
      { givesUp: true },
    )
    expect(withdrawn).toBe(true)
    expect(seen.responses).toEqual([{ action: 'cancel' }])
    const rows = tools() as ToolEntry[]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'failed' })
  })

  it('asks nothing of a version it was not measured on', async () => {
    const { seen, requests } = await ask('1.5.14', async () => ({ answers: [] }))
    expect(requests).toEqual([])
    expect(seen.responses).toEqual([{ action: 'decline' }])
  })

  it('declares forms for agy alone', async () => {
    const { connection, seen } = connect('1.5.15', 'gemini')
    await connection.initialize('1.0.0')
    expect(seen.capabilities.elicitation).toEqual({ url: {} })
    connection.close()
  })
})
