import { describe, expect, it } from 'vitest'
import { REQUESTS_PAGE } from '@shared/model-requests'
import {
  cursorBefore,
  opencodeModelRequests,
  parseOpenCodeMessages,
  type OpenCodeSessions,
} from './opencode'

const AGENT = 'opencode' as const
const SESSION = 'ses_e8ebcb20fffeGcSfNDq49g5hbE'
const target = {
  agentId: AGENT,
  cwd: '/',
  acpSessionId: SESSION,
  configDir: null,
  parentAcpSessionId: null,
}

const user = (id: string, text: string, at = 1000) => ({
  id: `msg_${id}`,
  type: 'user',
  time: { created: at },
  text,
  files: [],
})

const assistant = (id: string, content: object[], extra: object = {}) => ({
  id: `msg_${id}`,
  type: 'assistant',
  time: { created: 2000, completed: 3000 },
  agent: 'build',
  model: { id: 'deepseek-v4.1-flash', providerID: 'deepseek' },
  content,
  finish: 'tool-calls',
  cost: 0.0123,
  tokens: { input: 400, output: 90, reasoning: 30, cache: { read: 150_000, write: 0 } },
  ...extra,
})

const shell = (command: string, output: string) => ({
  type: 'tool',
  id: 'call_1',
  name: 'shell',
  state: {
    status: 'completed',
    input: { command, timeout: 120_000 },
    content: [{ type: 'text', text: output }],
    metadata: { exit: 0 },
  },
})

describe('parseOpenCodeMessages', () => {
  it('makes each assistant message a request, sending what came before it', () => {
    const turns = parseOpenCodeMessages([
      {
        ...user('a1', 'Fix the build'),
        files: [{ mime: 'image/png', name: 'shot', data: 'AAAA' }],
      },
      {
        id: 'msg_s1',
        type: 'system',
        time: { created: 1500 },
        text: 'The tool catalog has changed.',
        description: 'Instructions updated: core/codemode',
        metadata: { notice: 'instructions' },
      },
      assistant('b1', [
        { type: 'reasoning', text: 'Run the build first.' },
        shell('pnpm build', 'error TS2322'),
      ]),
      assistant('b2', [{ type: 'text', text: 'Fixed.' }], { finish: 'stop' }),
      { id: 'msg_i1', type: 'idle', time: { created: 3100 }, outcome: 'succeeded' },
      { id: 'msg_m1', type: 'model-switched', time: { created: 3200 }, model: { id: 'x' } },
    ])
    expect(turns).toHaveLength(1)
    const [turn] = turns
    expect(turn).toMatchObject({
      id: 'msg_a1',
      index: null,
      prompt: 'Fix the build',
      startedAt: 1000,
    })
    const [first, second] = turn.requests
    expect(first).toMatchObject({
      id: 'msg_b1',
      turnId: 'msg_a1',
      model: 'deepseek-v4.1-flash',
      stop: 'tool-calls',
      status: 'done',
      sentAt: 2000,
      endedAt: 3000,
      tokens: { input: 400, cacheRead: 150_000, cacheWrite: 0, output: 90, reasoning: 30 },
      params: [
        { name: 'agent', value: 'build' },
        { name: 'provider', value: 'deepseek' },
        { name: 'cost', value: '$0.0123' },
      ],
      records: 3,
      raw: 'msg_a1,msg_s1,msg_b1',
    })
    expect(first.sent.map((p) => [p.kind, p.label, p.preview, p.bytes])).toEqual([
      ['prompt', 'prompt', 'Fix the build', 13],
      ['attachment', 'image/png', 'shot', 3],
      ['other', 'system', 'Instructions updated: core/codemode', 29],
    ])
    expect(first.received.map((p) => [p.kind, p.label, p.preview])).toEqual([
      ['thinking', 'reasoning', 'Run the build first.'],
      ['tool-call', 'shell', 'pnpm build'],
    ])
    expect(first.actions).toEqual([
      { kind: 'thinking', label: 'Thinking', count: 1 },
      { kind: 'run', label: 'pnpm build', count: 1 },
    ])
    // The tool's output goes to the model with the next request.
    expect(second.sent.map((p) => [p.kind, p.preview])).toEqual([['tool-result', 'error TS2322']])
    expect(second).toMatchObject({ raw: 'msg_b2', records: 1, stop: 'stop' })
    expect(second.actions).toEqual([{ kind: 'reply', label: 'Reply', count: 1 }])
  })

  it('marks a request that failed or still runs, and a tool that failed', () => {
    const [turn] = parseOpenCodeMessages([
      user('a1', 'Go'),
      assistant(
        'b1',
        [
          {
            type: 'tool',
            name: 'webfetch',
            state: { status: 'error', input: { url: 'x' }, error: { message: '404 GET' } },
          },
        ],
        { finish: 'error', error: { type: 'provider.quota', message: 'Insufficient funds' } },
      ),
      assistant('b2', [{ type: 'reasoning', text: 'Thinking' }], {
        time: { created: 4000 },
        finish: undefined,
      }),
    ])
    expect(turn.requests[0]).toMatchObject({ status: 'failed', error: 'Insufficient funds' })
    expect(turn.requests[1]).toMatchObject({ status: 'running', endedAt: null })
    expect(turn.requests[1].sent).toEqual([
      expect.objectContaining({ kind: 'tool-result', preview: '404 GET', error: true }),
    ])
  })

  it('names Code Mode by the first tool its code calls, and reads paths', () => {
    const [turn] = parseOpenCodeMessages([
      user('a1', 'Go'),
      assistant('b1', [
        {
          type: 'tool',
          name: 'execute',
          state: { status: 'completed', input: { code: 'return await tools.opencode.models({})' } },
        },
        {
          type: 'tool',
          name: 'read',
          state: { status: 'completed', input: { path: '/repo/src/a.ts' } },
        },
        {
          type: 'tool',
          name: 'subagent',
          state: { status: 'completed', input: { agent: 'explore', prompt: 'Look' } },
        },
      ]),
    ])
    expect(turn.requests[0].actions).toEqual([
      { kind: 'tool', label: 'opencode.models', count: 1 },
      { kind: 'read', label: 'read a.ts', count: 1 },
      { kind: 'agent', label: 'subagent explore', count: 1 },
    ])
    expect(turn.requests[0].received.map((p) => [p.label, p.preview])).toEqual([
      ['execute', 'return await tools.opencode.models({})'],
      ['read', '/repo/src/a.ts'],
      ['subagent', 'explore'],
    ])
  })

  it('keeps requests whose prompt lies before the page in a turn of their own', () => {
    const turns = parseOpenCodeMessages([
      assistant('b1', []),
      user('a2', 'Next'),
      assistant('b2', []),
    ])
    expect(turns.map((t) => [t.id, t.prompt, t.requests.length])).toEqual([
      ['from:msg_b1', '', 1],
      ['msg_a2', 'Next', 1],
    ])
  })
})

/** OpenCode's paging over messages kept oldest first: 50 a page, newest first. */
function fakeSessions(messages: { id: string }[], extra: Partial<OpenCodeSessions> = {}) {
  const calls: (string | null)[] = []
  const sessions: OpenCodeSessions = {
    async messages(sessionId, cursor) {
      expect(sessionId).toBe(SESSION)
      calls.push(cursor)
      let end = messages.length
      if (cursor) {
        const { id } = JSON.parse(atob(cursor.replace(/-/g, '+').replace(/_/g, '/'))) as {
          id: string
        }
        end = messages.findIndex((m) => m.id === id)
      }
      const page = messages.slice(Math.max(0, end - 50), end).reverse()
      const oldest = end - page.length
      return { messages: page, next: oldest > 0 ? cursorBefore(page.at(-1)!.id) : null }
    },
    async message(_sessionId, id) {
      return messages.find((m) => m.id === id) ?? null
    },
    async session() {
      return { cost: 0, tokens: { input: 349_307, output: 15_213, cache: { read: 10, write: 0 } } }
    },
    ...extra,
  }
  return { sessions, calls }
}

/** Turns of one prompt and `size` requests each, oldest first. */
function history(turns: number, size: number) {
  const out = []
  for (let t = 0; t < turns; t++) {
    out.push(user(`t${t}`, `Prompt ${t}`))
    for (let r = 0; r < size; r++) out.push(assistant(`t${t}r${r}`, []))
  }
  return out
}

describe('opencodeModelRequests', () => {
  it('reads back whole turns a page at a time, each page starting at a prompt', async () => {
    const all = history(5, 20)
    const { sessions } = fakeSessions(all)
    const reader = opencodeModelRequests({ sessions: () => sessions })
    const first = await reader.page(target, null)
    const firstIds = first!.turns.map((t) => t.id)
    expect(first!.turns.flatMap((t) => t.requests).length).toBeGreaterThanOrEqual(REQUESTS_PAGE)
    expect(firstIds).toEqual(['msg_t2', 'msg_t3', 'msg_t4'])
    expect(first!.before).toBe(cursorBefore('msg_t2'))
    const second = await reader.page(target, first!.before)
    expect(second!.turns.map((t) => t.id)).toEqual(['msg_t0', 'msg_t1'])
    expect(second!.before).toBeNull()
  })

  it('keeps the instructions before a prompt on its page, sent with its first request', async () => {
    const all = history(3, 30).flatMap((m) =>
      m.type === 'user'
        ? [
            { id: `msg_x${m.id}`, type: 'synthetic', time: { created: 900 }, text: 'AGENTS.md' },
            { id: `msg_i${m.id}`, type: 'idle', time: { created: 950 } },
            m,
          ]
        : [m],
    )
    const { sessions } = fakeSessions(all)
    const reader = opencodeModelRequests({ sessions: () => sessions })
    const first = await reader.page(target, null)
    expect(first!.turns.map((t) => t.id)).toEqual(['msg_t1', 'msg_t2'])
    expect(first!.turns[0].requests[0].sent.map((p) => p.kind)).toEqual(['other', 'prompt'])
    expect(first!.before).toBe(cursorBefore('msg_xmsg_t1'))
    const second = await reader.page(target, first!.before)
    expect(second!.turns.map((t) => t.id)).toEqual(['msg_t0'])
    expect(second!.turns[0].requests[0].raw).toBe('msg_xmsg_t0,msg_t0,msg_t0r0')
  })

  it('stops reading back after a few pages inside one long turn', async () => {
    const all = history(1, 600)
    const { sessions, calls } = fakeSessions(all)
    const reader = opencodeModelRequests({ sessions: () => sessions })
    const page = await reader.page(target, null)
    expect(calls).toHaveLength(8)
    expect(page!.turns).toHaveLength(1)
    expect(page!.turns[0]).toMatchObject({ prompt: '', id: expect.stringMatching(/^from:/) })
    expect(page!.before).not.toBeNull()
  })

  it('reads nothing for an agent that is not OpenCode', async () => {
    const reader = opencodeModelRequests({ sessions: () => null })
    expect(await reader.page(target, null)).toBeNull()
    expect(await reader.summary(target)).toBeNull()
    await expect(reader.raw(target, 'msg_a', false)).rejects.toThrow()
  })

  it('takes the totals OpenCode keeps, with no cost where it has no price', async () => {
    const { sessions } = fakeSessions([])
    const reader = opencodeModelRequests({ sessions: () => sessions })
    expect(await reader.summary(target)).toEqual({
      source: 'opencode',
      requests: null,
      costUsd: null,
      tokens: {
        input: 349_307,
        cacheRead: 10,
        cacheWrite: 0,
        cacheWrite1h: null,
        output: 15_213,
        reasoning: null,
      },
      system: null,
      turns: null,
    })
  })

  it('reads a request’s messages again for Raw, and only messages', async () => {
    const all = history(1, 2)
    const { sessions } = fakeSessions(all)
    const reader = opencodeModelRequests({ sessions: () => sessions })
    const page = await reader.page(target, null)
    const raw = await reader.raw(target, page!.turns[0].requests[0].raw, false)
    expect(raw.records.map((r) => (r as { id: string }).id)).toEqual(['msg_t0', 'msg_t0r0'])
    await expect(reader.raw(target, '0-10', false)).rejects.toThrow('Not a request')
    await expect(reader.raw(target, 'system', false)).rejects.toThrow('Not a request')
    await expect(reader.raw(target, 'msg_gone', false)).rejects.toThrow('no longer has')
  })

  it('reads the messages of a forked session, whose ids end in a copy number', async () => {
    const forked = [user('t0_4', 'Prompt'), assistant('t0r0_4', [])]
    const { sessions } = fakeSessions(forked)
    const reader = opencodeModelRequests({ sessions: () => sessions })
    const page = await reader.page(target, null)
    const raw = await reader.raw(target, page!.turns[0].requests[0].raw, false)
    expect(raw.records.map((r) => (r as { id: string }).id)).toEqual(['msg_t0_4', 'msg_t0r0_4'])
    await expect(reader.raw(target, 'msg_t0_4/../x', false)).rejects.toThrow('Not a request')
  })
})
