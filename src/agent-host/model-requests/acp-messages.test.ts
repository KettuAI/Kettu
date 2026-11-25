import { describe, expect, it } from 'vitest'
import { AcpMessages, SESSION_MESSAGES, SESSIONS, acpModelRequests, acpTurns } from './acp-messages'

const AGENT = 'pi' as const

function feed(
  store: AcpMessages,
  sessionId: string,
  rpcId: number,
  text: string,
  stop = 'end_turn',
) {
  const update = (u: object) => ({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId, update: u },
  })
  store.add(AGENT, 'out', {
    jsonrpc: '2.0',
    id: rpcId,
    method: 'session/prompt',
    params: { sessionId, prompt: [{ type: 'text', text }] },
  })
  store.add(
    AGENT,
    'in',
    update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Plan' } }),
  )
  store.add(
    AGENT,
    'in',
    update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read a.ts', kind: 'read' }),
  )
  store.add(
    AGENT,
    'in',
    update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' }),
  )
  // The agent asks; Kettu answers with no session in its response.
  store.add(AGENT, 'in', {
    jsonrpc: '2.0',
    id: 90 + rpcId,
    method: 'session/request_permission',
    params: { sessionId },
  })
  store.add(AGENT, 'out', {
    jsonrpc: '2.0',
    id: 90 + rpcId,
    result: { outcome: { outcome: 'selected' } },
  })
  store.add(
    AGENT,
    'in',
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Do' } }),
  )
  store.add(
    AGENT,
    'in',
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ne.' } }),
  )
  store.add(AGENT, 'in', {
    jsonrpc: '2.0',
    id: rpcId,
    result: {
      stopReason: stop,
      usage: { inputTokens: 1200, outputTokens: 80, cachedReadTokens: 1000 },
    },
  })
}

describe('AcpMessages', () => {
  it('keeps each session its own messages, responses found by their request', () => {
    const store = new AcpMessages()
    feed(store, 's1', 1, 'First')
    feed(store, 's2', 2, 'Other')
    expect(store.of(AGENT, 's1')).toHaveLength(9)
    expect(store.of(AGENT, 's2')).toHaveLength(9)
    expect(
      store
        .of(AGENT, 's1')
        .map((m) => m.direction[0])
        .join(''),
    ).toBe('oiiiioiii')
  })

  it('reads a turn from its prompt to its answer', () => {
    const store = new AcpMessages()
    feed(store, 's1', 1, '<kettu-guide>You are working in Kettu.</kettu-guide> Sketch the dialog')
    const [turn] = acpTurns(store.of(AGENT, 's1'))
    expect(turn).toMatchObject({ prompt: 'Sketch the dialog', index: null })
    const [request] = turn.requests
    expect(request).toMatchObject({
      status: 'done',
      stop: 'end_turn',
      records: 9,
      tokens: { input: 1200, cacheRead: 1000, output: 80 },
    })
    expect(request.actions).toEqual([
      { kind: 'thinking', label: 'Thinking', count: 1 },
      { kind: 'read', label: 'Read a.ts', count: 1 },
      { kind: 'reply', label: 'Reply', count: 1 },
    ])
    expect(request.received.map((p) => [p.label, p.count, p.preview])).toEqual([
      ['agent_thought_chunk', 1, 'Plan'],
      ['tool_call', 1, 'Read a.ts'],
      ['tool_call_update', 1, ''],
      ['session/request_permission', 1, ''],
      ['agent_message_chunk', 2, 'Done.'],
      ['result', 1, 'end_turn'],
    ])
    expect(request.sent.map((p) => [p.label, p.count])).toEqual([
      ['session/prompt', 1],
      ['result', 1],
    ])
  })

  it("sums the model calls a turn's chunks carry when its answer reports no usage", () => {
    // Qwen Code 0.28.4: an empty chunk per model call, and a prompt answer without usage.
    const store = new AcpMessages()
    const usage = (u: object) => ({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 's1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: '' },
          _meta: { usage: u },
        },
      },
    })
    store.add('qwen', 'out', {
      jsonrpc: '2.0',
      id: 1,
      method: 'session/prompt',
      params: { sessionId: 's1', prompt: [{ type: 'text', text: 'Go' }] },
    })
    store.add(
      'qwen',
      'in',
      usage({ inputTokens: 12000, outputTokens: 300, totalTokens: 12300, cachedReadTokens: 10000 }),
    )
    store.add(
      'qwen',
      'in',
      usage({ inputTokens: 12800, outputTokens: 150, totalTokens: 12950, cachedReadTokens: 12000 }),
    )
    store.add('qwen', 'in', { jsonrpc: '2.0', id: 1, result: { stopReason: 'end_turn' } })
    const [turn] = acpTurns(store.of('qwen', 's1'))
    expect(turn!.requests[0]!.tokens).toEqual({
      input: 2800,
      cacheRead: 22000,
      cacheWrite: null,
      cacheWrite1h: null,
      output: 450,
      reasoning: null,
    })
  })

  it('drops the oldest messages and the least recent sessions past their bounds', () => {
    const store = new AcpMessages()
    for (let i = 0; i < SESSION_MESSAGES + 5; i++) {
      store.add(AGENT, 'in', {
        method: 'session/update',
        params: { sessionId: 's1', update: { n: i } },
      })
    }
    const kept = store.of(AGENT, 's1')
    expect(kept).toHaveLength(SESSION_MESSAGES)
    expect(JSON.parse(kept[0].text).params.update.n).toBe(5)
    for (let i = 0; i < SESSIONS; i++) {
      store.add(AGENT, 'in', {
        method: 'session/update',
        params: { sessionId: `x${i}`, update: {} },
      })
    }
    expect(store.of(AGENT, 's1')).toHaveLength(0)
  })

  it('reads a turn back as the messages Kettu exchanged', async () => {
    const store = new AcpMessages()
    feed(store, 's1', 1, 'First')
    const reader = acpModelRequests(store)
    const target = {
      agentId: AGENT,
      cwd: '/',
      acpSessionId: 's1',
      configDir: null,
      parentAcpSessionId: null,
    }
    const page = await reader.page(target, null)
    const raw = await reader.raw(target, page!.turns[0].requests[0].raw, false)
    expect(raw.records).toHaveLength(9)
    expect((raw.records[0] as { method: string }).method).toBe('session/prompt')
    expect(await reader.summary(target)).toMatchObject({
      source: 'acp',
      requests: 1,
      tokens: { input: 1200 },
    })
  })
})
