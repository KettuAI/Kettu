import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { REQUESTS_PAGE } from '@shared/model-requests'
import type { TranscriptLine } from './claude-transcript'
import { codexModelRequests, findCodexRollout } from './codex'
import { parseCodexRollout } from './codex-rollout'

// A UUIDv7 made on 2026-11-18, as Codex names its threads.
const THREAD = '01a1e036-294e-78f0-aa1d-ef3e8876ff00'
const AT = '2026-11-18T06:00:00.000Z'

const record = (type: string, payload: object, timestamp = AT) => ({ timestamp, type, payload })
const item = (payload: object, timestamp = AT) => record('response_item', payload, timestamp)

function turnContext(turnId: string) {
  return record('turn_context', {
    turn_id: turnId,
    model: 'gpt-6-sol',
    effort: 'high',
    summary: 'detailed',
    approval_policy: 'on-request',
    sandbox_policy: { type: 'workspace-write' },
    collaboration_mode: { settings: { developer_instructions: 'Be brief.' } },
  })
}

function usage(responseId: string, turnId: string, timestamp = AT) {
  return record(
    'token_usage_record',
    {
      response_id: responseId,
      turn_id: turnId,
      usage: {
        input_tokens: 41_000,
        cached_input_tokens: 36_000,
        cache_write_input_tokens: 2_000,
        output_tokens: 600,
        reasoning_output_tokens: 200,
        total_tokens: 41_600,
      },
      thread_token_usage: {
        input_tokens: 82_000,
        cached_input_tokens: 72_000,
        cache_write_input_tokens: 4_000,
        output_tokens: 1_200,
        reasoning_output_tokens: 400,
        total_tokens: 83_200,
      },
    },
    timestamp,
  )
}

function lines(records: object[]): TranscriptLine[] {
  let at = 0
  return records.map((r) => {
    const length = JSON.stringify(r).length
    const line = { start: at, end: at + length, record: r as Record<string, unknown> }
    at += length + 1
    return line
  })
}

/** One turn: the user's message, then `n` requests each calling a command, then a reply. */
function turn(turnId: string, text: string, n: number, from = 0): object[] {
  const out: object[] = [
    turnContext(turnId),
    item({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }),
    record('event_msg', { type: 'user_message', message: text }),
  ]
  for (let i = 0; i < n; i++) {
    out.push(
      item({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'Look first.' }] }),
      item({
        type: 'function_call',
        name: 'shell',
        arguments: JSON.stringify({ command: ['git', 'worktree', 'list'] }),
        call_id: `c${from + i}`,
      }),
      usage(`resp_${from + i}`, turnId, `2026-11-18T06:00:0${(i % 9) + 1}.000Z`),
      item({ type: 'function_call_output', call_id: `c${from + i}`, output: 'main' }),
    )
  }
  out.push(
    item({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] }),
    usage(`resp_${from + n}`, turnId),
  )
  return out
}

describe('parseCodexRollout', () => {
  it('ends each request at its usage record, with what was sent before it', () => {
    const parsed = parseCodexRollout(lines(turn('t1', 'Review the cleanup', 2)))
    expect(parsed.turns).toHaveLength(1)
    const [first, second, reply] = parsed.turns[0].requests
    expect(parsed.turns[0]).toMatchObject({ id: 't1', prompt: 'Review the cleanup' })
    expect(first).toMatchObject({
      id: 'resp_0',
      model: 'gpt-6-sol',
      status: 'done',
      tokens: { input: 3_000, cacheRead: 36_000, cacheWrite: 2_000, output: 600, reasoning: 200 },
    })
    expect(first.params).toEqual([
      { name: 'effort', value: 'high' },
      { name: 'summary', value: 'detailed' },
      { name: 'sandbox', value: 'workspace-write' },
      { name: 'approval', value: 'on-request' },
    ])
    expect(first.sent.map((p) => p.kind)).toEqual(['prompt'])
    expect(first.received.map((p) => p.kind)).toEqual(['thinking', 'tool-call'])
    expect(first.actions).toEqual([
      { kind: 'thinking', label: 'Thinking', count: 1 },
      { kind: 'run', label: 'git worktree list', count: 1 },
    ])
    expect(second.sent.map((p) => p.kind)).toEqual(['tool-result'])
    expect(reply.actions).toEqual([{ kind: 'reply', label: 'Reply', count: 1 }])
  })

  it('ends requests at token counts in older rollouts, once each', () => {
    const count = (input: number) =>
      record('event_msg', {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: input, output_tokens: 10 },
          last_token_usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 },
        },
      })
    const parsed = parseCodexRollout(
      lines([
        turnContext('t1'),
        item({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a' }] }),
        count(100),
        // Repeated after a tool ran, with nothing new used.
        count(100),
        item({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'b' }] }),
        count(200),
      ]),
    )
    expect(parsed.turns[0].requests.map((r) => r.tokens.input)).toEqual([20, 20])
  })

  it('names an exec call by the first tool its code calls', () => {
    const call = (input: string) =>
      item({ type: 'custom_tool_call', name: 'exec', input, call_id: 'x' })
    const parsed = parseCodexRollout(
      lines([
        turnContext('t1'),
        call('text(await tools.exec_command({cmd:"git status --short",yield_time_ms:1000}))'),
        usage('r1', 't1'),
        call('await tools.mcp__kettu__set_plan({steps:[]})'),
        usage('r2', 't1'),
        call('const cmd=`pnpm test`;\ntext(await tools.exec_command({cmd,workdir:w}))'),
        usage('r3', 't1'),
        call(
          'const cmds=["git log -1","git status"];\nfor (const c of cmds) await tools.exec_command({cmd:c})',
        ),
        usage('r4', 't1'),
      ]),
    )
    expect(parsed.turns[0].requests.map((r) => r.actions[0])).toEqual([
      { kind: 'run', label: 'git status --short', count: 1 },
      { kind: 'tool', label: 'set_plan', count: 1 },
      { kind: 'run', label: 'pnpm test', count: 1 },
      { kind: 'run', label: 'git log -1', count: 1 },
    ])
  })

  it('shows the request in flight', () => {
    const parsed = parseCodexRollout(
      lines([
        turnContext('t1'),
        item({ type: 'reasoning', summary: [] }),
        item({ type: 'function_call', name: 'shell', arguments: '{"command":["ls"]}' }),
      ]),
    )
    expect(parsed.turns[0].requests).toMatchObject([{ status: 'running', endedAt: null }])
  })
})

describe('reading a rollout', () => {
  let home: string

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'kettu-codex-'))
  })
  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  async function write(records: object[], compressed = false): Promise<string> {
    const made = new Date(Number.parseInt(THREAD.replace(/-/g, '').slice(0, 12), 16))
    const folder = path.join(
      home,
      'sessions',
      String(made.getFullYear()),
      String(made.getMonth() + 1).padStart(2, '0'),
      String(made.getDate()).padStart(2, '0'),
    )
    await mkdir(folder, { recursive: true })
    const text = records.map((r) => JSON.stringify(r)).join('\n') + '\n'
    const file = path.join(
      folder,
      `rollout-2026-11-18T06-00-00-${THREAD}.jsonl${compressed ? '.zst' : ''}`,
    )
    await writeFile(file, compressed ? zstdCompressSync(Buffer.from(text)) : text)
    return file
  }

  const target = () => ({
    agentId: 'codex' as const,
    cwd: '/repo',
    acpSessionId: THREAD,
    configDir: home,
    parentAcpSessionId: null,
  })

  it('finds a thread by the day its id was made', async () => {
    const file = await write([turnContext('t1')])
    expect(await findCodexRollout(home, THREAD)).toBe(file)
    expect(await findCodexRollout(home, 'not-a-thread')).toBeNull()
  })

  it('pages a compressed rollout back to a turn start, and reads its records', async () => {
    const records: object[] = [
      record('session_meta', { id: THREAD, base_instructions: { text: 'You are Codex.' } }),
      item({
        type: 'additional_tools',
        role: 'developer',
        tools: [
          {
            type: 'namespace',
            name: 'functions',
            tools: [{ name: 'exec' }, { name: 'apply_patch' }],
          },
          { type: 'namespace', name: 'mcp__kettu', tools: [{ name: 'set_plan' }] },
        ],
      }),
    ]
    for (let t = 0; t < 8; t++) records.push(...turn(`t${t}`, `Turn ${t}`, 9, t * 10))
    await write(records, true)
    const reader = codexModelRequests({ home: '/nowhere', env: async () => ({}) })
    const page = await reader.page(target(), null)
    const requests = page!.turns.flatMap((t) => t.requests)
    expect(requests.length).toBeGreaterThanOrEqual(REQUESTS_PAGE)
    expect(page!.turns[0].prompt).toMatch(/^Turn /)
    expect(page!.before).not.toBeNull()

    const summary = await reader.summary(target())
    expect(summary).toMatchObject({
      source: 'codex',
      requests: 80,
      costUsd: null,
      tokens: { input: 6_000, cacheRead: 72_000, cacheWrite: 4_000, output: 1_200, reasoning: 400 },
      system: {
        kind: 'instructions',
        blocks: [{ chars: 14 }, { chars: 9 }],
        groups: [
          { kind: 'builtin', name: 'builtin', tools: ['exec', 'apply_patch'] },
          { kind: 'mcp', name: 'kettu', tools: ['set_plan'] },
        ],
        toolCount: 3,
      },
    })
    expect(summary!.turns).toMatchObject({ t0: 1, t7: 8 })

    const raw = await reader.raw(target(), requests[0].raw, false)
    expect(raw.records.length).toBe(requests[0].records)
  })
})
