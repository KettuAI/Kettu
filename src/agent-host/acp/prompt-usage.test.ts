// A turn's tokens from an ACP agent: from its prompt response when it reports them there, else
// summed from the model calls its message chunks carry, as Qwen Code 0.28.4 sends them.

import { agent, methods, type SessionUpdate } from '@agentclientprotocol/sdk/unstable'
import { describe, expect, it } from 'vitest'
import type { SessionTarget } from '../connection'
import { AcpConnection, inProcessTransport } from './connection'

const text = (value: string): SessionUpdate => ({
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'text', text: value },
})

/** The chunk Qwen Code sends once a model call ends, its input holding the cache reads. */
const call = (usage: Record<string, number>, meta: object = {}): SessionUpdate => ({
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'text', text: '' },
  _meta: { usage, durationMs: 2100, ...meta },
})

async function turn(updates: readonly SessionUpdate[], response: object) {
  const app = agent({ name: 'prompt-usage-test' })
    .onRequest(methods.agent.initialize, () => ({
      protocolVersion: 1,
      agentCapabilities: {},
      agentInfo: { name: 'qwen-code', version: '0.28.4' },
    }))
    .onRequest(methods.agent.session.new, () => ({ sessionId: 's-1' }))
    .onRequest(methods.agent.session.prompt, async (ctx) => {
      for (const update of updates) {
        await ctx.client.notify(methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update,
        })
      }
      return { stopReason: 'end_turn' as const, ...response }
    })
  const connection = AcpConnection.connect(inProcessTransport(app), {
    traffic: () => {},
    account: () => {},
    ignored: () => {},
    log: () => {},
    agentId: 'qwen',
  })
  const target = {
    context: () => ({ replaying: false }),
    apply: () => {},
  } as unknown as SessionTarget
  await connection.initialize('1.0.0')
  const { sessionId } = await connection.newSession('/tmp/probe')
  connection.register(sessionId, target)
  const first = await connection.prompt(sessionId, [{ type: 'text', text: 'go' }])
  // The next turn starts its own count.
  const second = await connection.prompt(sessionId, [{ type: 'text', text: 'again' }])
  connection.close()
  return { first, second }
}

const calls = [
  text('Reading the file'),
  call({ inputTokens: 12000, outputTokens: 300, totalTokens: 12300, cachedReadTokens: 10000 }),
  { sessionUpdate: 'usage_update', used: 12000, size: 131072 } as SessionUpdate,
  // A subagent's call, which Qwen Code reports in its parent's session.
  call(
    { inputTokens: 4000, outputTokens: 100, totalTokens: 4100 },
    { parentToolCallId: 'call_1', subagentType: 'general-purpose' },
  ),
  text('Done.'),
  call({
    inputTokens: 12800,
    outputTokens: 150,
    totalTokens: 12950,
    thoughtTokens: 40,
    cachedReadTokens: 12000,
  }),
]

describe('a turn of an ACP agent', () => {
  it('sums the model calls its chunks carry when the response reports no usage', async () => {
    const { first, second } = await turn(calls, {})
    expect(first.tokens).toEqual({
      total: 29350,
      input: 6800,
      output: 550,
      thought: 40,
      cacheRead: 22000,
      cacheWrite: null,
    })
    expect(second.tokens).toEqual(first.tokens)
  })

  it("keeps the response's usage, never adding the chunks' to it", async () => {
    const usage = { inputTokens: 900, outputTokens: 80, totalTokens: 980 }
    const { first } = await turn(calls, { usage })
    expect(first.tokens).toEqual({
      total: 980,
      input: 900,
      output: 80,
      thought: null,
      cacheRead: null,
      cacheWrite: null,
    })
  })

  it('reports no tokens when neither the response nor a chunk has them', async () => {
    const { first } = await turn([text('Hi')], {})
    expect(first.tokens).toBeNull()
  })
})

/** goose's own notification of one model call, its input holding the call's cache reads. */
const gooseCall = (messageId: string, usage: Record<string, number>) => ({
  update: { sessionUpdate: 'message_usage', messageId, usage: { ...usage, isCompaction: false } },
})

/** goose's other updates of its own, which are read for nothing. */
const gooseOther = [
  {
    update: {
      sessionUpdate: 'usage_update',
      used: 12950,
      contextLimit: 200000,
      accumulatedInputTokens: 24800,
      accumulatedOutputTokens: 450,
    },
  },
  { update: { sessionUpdate: 'status_message', status: { type: 'notice', message: 'Compacted' } } },
  {
    update: {
      sessionUpdate: 'live_voice_interaction_ended',
      interactionId: 'l1',
      outcome: 'stopped',
    },
  },
]

/**
 * A turn of an agent that, as goose does, sends its own notifications only to a client whose
 * initialize declares them, and reports only the latest model call on its prompt response.
 */
async function gooseTurn(
  agentId: 'goose' | 'qwen',
  notes: readonly object[],
  latest: { inputTokens: number; outputTokens: number; totalTokens: number },
) {
  let declared = false
  const ignored: string[] = []
  const app = agent({ name: 'prompt-usage-test' })
    .onRequest(methods.agent.initialize, (ctx) => {
      const meta = ctx.params.clientCapabilities?._meta as
        { goose?: { customNotifications?: boolean } } | undefined
      declared = meta?.goose?.customNotifications === true
      return {
        protocolVersion: 1,
        agentCapabilities: {},
        agentInfo: { name: agentId, version: '1.0.0' },
      }
    })
    .onRequest(methods.agent.session.new, () => ({ sessionId: 's-1' }))
    .onRequest(methods.agent.session.prompt, async (ctx) => {
      await ctx.client.notify(methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: text('Done.'),
      })
      for (const note of notes) {
        await ctx.client.notify('_goose/unstable/session/update', {
          sessionId: ctx.params.sessionId,
          ...note,
        })
      }
      return { stopReason: 'end_turn' as const, usage: latest }
    })
  const connection = AcpConnection.connect(inProcessTransport(app), {
    traffic: () => {},
    account: () => {},
    ignored: (_sessionId, what) => ignored.push(what),
    log: () => {},
    agentId,
  })
  const target = {
    context: () => ({ replaying: false }),
    apply: () => {},
  } as unknown as SessionTarget
  await connection.initialize('1.0.0')
  const { sessionId } = await connection.newSession('/tmp/probe')
  connection.register(sessionId, target)
  const first = await connection.prompt(sessionId, [{ type: 'text', text: 'go' }])
  connection.close()
  return { declared, first, ignored }
}

const firstCall = {
  inputTokens: 12000,
  outputTokens: 300,
  totalTokens: 12300,
  cacheReadTokens: 10000,
}
const lastCall = {
  inputTokens: 12800,
  outputTokens: 150,
  totalTokens: 12950,
  cacheReadTokens: 12000,
  cacheWriteTokens: 200,
}
// goose 1.x's prompt response: the latest call's input, output and total only.
const latest = { inputTokens: 12800, outputTokens: 150, totalTokens: 12950 }
const bothCalls = {
  total: 25250,
  input: 2600,
  output: 450,
  thought: null,
  cacheRead: 22000,
  cacheWrite: 200,
}

describe('a turn of goose', () => {
  it('sums every model call its own notifications report over the latest one', async () => {
    const notes = [gooseCall('m1', firstCall), ...gooseOther, gooseCall('m2', lastCall)]
    const { declared, first, ignored } = await gooseTurn('goose', notes, latest)
    expect(declared).toBe(true)
    expect(first.tokens).toEqual(bothCalls)
    expect(ignored).toEqual([])
  })

  it('counts a message reported twice once', async () => {
    const notes = [
      gooseCall('m1', firstCall),
      gooseCall('m2', lastCall),
      gooseCall('m1', firstCall),
    ]
    const { first } = await gooseTurn('goose', notes, latest)
    expect(first.tokens).toEqual(bothCalls)
  })

  it("keeps the response's usage when no call was reported", async () => {
    const { first } = await gooseTurn('goose', gooseOther, latest)
    expect(first.tokens).toEqual({
      total: 12950,
      input: 12800,
      output: 150,
      thought: null,
      cacheRead: null,
      cacheWrite: null,
    })
  })

  it("leaves other agents on their response's usage, declaring nothing of goose's", async () => {
    const notes = [gooseCall('m1', firstCall), gooseCall('m2', lastCall)]
    const { declared, first } = await gooseTurn('qwen', notes, latest)
    expect(declared).toBe(false)
    expect(first.tokens).toEqual({
      total: 12950,
      input: 12800,
      output: 150,
      thought: null,
      cacheRead: null,
      cacheWrite: null,
    })
  })
})
