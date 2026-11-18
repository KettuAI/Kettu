import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RAW_FOLDED, REQUESTS_PAGE, foldedBytes } from '@shared/model-requests'
import { claudeModelRequests, readPage, summarizeFile } from './claude'
import { decodeRanges, parseClaudeTranscript, type TranscriptLine } from './claude-transcript'

const SESSION = 'f00d0000-0000-4000-8000-000000000001'

function prompt(promptId: string, turnIndex: number, text: string, at: string) {
  return {
    parentUuid: null,
    promptId,
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    uuid: `u-${promptId}`,
    timestamp: at,
    turnPosition: { promptIndex: 0, turnIndex },
    sessionId: SESSION,
  }
}

function toolResult(promptId: string, text: string, at: string) {
  return {
    promptId,
    type: 'user',
    message: {
      role: 'user',
      content: [{ tool_use_id: 'toolu_1', type: 'tool_result', content: text }],
    },
    timestamp: at,
    toolUseResult: text,
    sessionId: SESSION,
  }
}

function apiRequest(id: string, at: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'api-request',
    sessionId: SESSION,
    id,
    timestamp: at,
    version: '2.1.326',
    querySource: 'sdk',
    shapeHash: 'shape-1',
    params: {
      model: 'claude-opus-5-5',
      max_tokens: 64000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'xhigh' },
    },
    keep: 4,
    tail: ['a', 'b'],
    cacheControl: [{ path: ['system', 2], value: { type: 'ephemeral', ttl: '1h' } }],
    ...extra,
  }
}

function assistant(
  ref: string | null,
  messageId: string,
  content: unknown[],
  at: string,
  usage = true,
) {
  return {
    type: 'assistant',
    ...(ref ? { requestRef: ref } : {}),
    requestId: `req_${messageId}`,
    timestamp: at,
    message: {
      model: 'claude-opus-5-5',
      id: messageId,
      role: 'assistant',
      content,
      stop_reason: 'tool_use',
      ...(usage
        ? {
            usage: {
              input_tokens: 12,
              cache_read_input_tokens: 9000,
              cache_creation_input_tokens: 300,
              cache_creation: { ephemeral_1h_input_tokens: 300, ephemeral_5m_input_tokens: 0 },
              output_tokens: 80,
              output_tokens_details: { thinking_tokens: 20 },
            },
          }
        : {}),
    },
  }
}

function lines(records: object[]): TranscriptLine[] {
  let at = 0
  return records.map((record) => {
    const length = JSON.stringify(record).length
    const line = { start: at, end: at + length, record: record as Record<string, unknown> }
    at += length + 1
    return line
  })
}

describe('parseClaudeTranscript', () => {
  it('joins each request with what was sent before it and the response that names it', () => {
    const parsed = parseClaudeTranscript(
      lines([
        prompt('p1', 3, 'Archive should also remove the worktree', '2026-11-18T06:02:00.000Z'),
        {
          type: 'attachment',
          attachment: { type: 'date' },
          rendered: [{ content: 'Today is 2026-11-18' }],
        },
        apiRequest('r1', '2026-11-18T06:02:01.000Z'),
        assistant(
          'r1',
          'msg_1',
          [{ type: 'thinking', thinking: 'The archive path…' }],
          '2026-11-18T06:02:03.000Z',
        ),
        assistant(
          'r1',
          'msg_1',
          [
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'Read',
              input: { file_path: '/repo/src/a.ts' },
            },
            {
              type: 'tool_use',
              id: 'toolu_2',
              name: 'Read',
              input: { file_path: '/repo/src/b.ts' },
            },
          ],
          '2026-11-18T06:02:05.000Z',
        ),
        toolResult('p1', 'export const a = 1', '2026-11-18T06:02:06.000Z'),
        apiRequest('r2', '2026-11-18T06:02:07.000Z'),
        assistant('r2', 'msg_2', [{ type: 'text', text: 'Done.' }], '2026-11-18T06:02:09.000Z'),
      ]),
    )
    expect(parsed.turns).toHaveLength(1)
    const [turn] = parsed.turns
    expect(turn).toMatchObject({
      id: 'p1',
      index: 3,
      prompt: 'Archive should also remove the worktree',
    })
    const [first, second] = turn.requests
    expect(first).toMatchObject({
      id: 'r1',
      turnId: 'p1',
      model: 'claude-opus-5-5',
      requestId: 'req_msg_1',
      stop: 'tool_use',
      status: 'done',
      kept: 4,
      added: 2,
      sentAt: Date.parse('2026-11-18T06:02:01.000Z'),
      endedAt: Date.parse('2026-11-18T06:02:05.000Z'),
      tokens: {
        input: 12,
        cacheRead: 9000,
        cacheWrite: 300,
        cacheWrite1h: 300,
        output: 80,
        reasoning: 20,
      },
      records: 5,
    })
    expect(first.params).toEqual([
      { name: 'effort', value: 'xhigh' },
      { name: 'thinking', value: 'adaptive' },
      { name: 'max_tokens', value: '64,000' },
      { name: 'cache', value: '1h' },
    ])
    expect(first.sent.map((p) => p.kind)).toEqual(['prompt', 'attachment'])
    expect(first.received.map((p) => p.kind)).toEqual(['thinking', 'tool-call', 'tool-call'])
    expect(first.actions).toEqual([
      { kind: 'thinking', label: 'Thinking', count: 1 },
      { kind: 'read', label: 'Read', count: 2 },
    ])
    expect(second.sent).toEqual([
      { kind: 'tool-result', label: 'tool_result', preview: 'export const a = 1', bytes: 18 },
    ])
    expect(second.actions).toEqual([{ kind: 'reply', label: 'Reply', count: 1 }])
    expect(decodeRanges(first.raw)).toHaveLength(5)
  })

  it('marks a request that failed with its error, and the next try as its own request', () => {
    const parsed = parseClaudeTranscript(
      lines([
        prompt('p1', 1, 'Hi', '2026-11-18T06:00:00.000Z'),
        apiRequest('r1', '2026-11-18T06:00:01.000Z'),
        {
          type: 'system',
          subtype: 'api_error',
          error: { status: 529, message: 'Overloaded' },
          retryAttempt: 1,
          maxRetries: 10,
        },
        apiRequest('r2', '2026-11-18T06:00:03.000Z'),
        {
          type: 'system',
          subtype: 'api_error',
          error: { status: 529, message: 'Overloaded' },
          retryAttempt: 2,
          maxRetries: 10,
        },
        assistant(
          null,
          'msg_x',
          [{ type: 'text', text: 'API Error: 529 Overloaded' }],
          '2026-11-18T06:00:04.000Z',
          false,
        ),
      ]).map((line) => {
        const message = line.record.message as Record<string, unknown> | undefined
        if (message) message.model = '<synthetic>'
        return line
      }),
    )
    const [first, second] = parsed.turns[0].requests
    expect(first).toMatchObject({ status: 'failed', error: '529 Overloaded · retry 1/10' })
    expect(second).toMatchObject({ status: 'failed', error: '529 Overloaded · retry 2/10' })
    expect(parsed.turns[0].requests).toHaveLength(2)
  })

  it('makes each response its own request in files without request records', () => {
    const parsed = parseClaudeTranscript(
      lines([
        prompt('p1', 1, 'Hi', '2026-11-18T06:00:00.000Z'),
        assistant(
          null,
          'msg_1',
          [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }],
          '2026-11-18T06:00:02.000Z',
        ),
        toolResult('p1', 'a.ts', '2026-11-18T06:00:03.000Z'),
        assistant(
          null,
          'msg_2',
          [{ type: 'text', text: 'Two files.' }],
          '2026-11-18T06:00:04.000Z',
        ),
      ]),
    )
    const requests = parsed.turns[0].requests
    expect(requests.map((r) => r.id)).toEqual(['msg_1', 'msg_2'])
    expect(requests[0]).toMatchObject({ params: [], sentAt: null, status: 'done' })
    expect(requests[0].actions).toEqual([{ kind: 'run', label: 'Bash ls', count: 1 }])
    expect(requests[1].sent.map((p) => p.kind)).toEqual(['tool-result'])
  })
})

describe('reading a session file', () => {
  let dir: string
  let file: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'kettu-requests-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function write(records: object[]): Promise<void> {
    file = path.join(dir, 'projects', '-repo', `${SESSION}.jsonl`)
    await import('node:fs/promises').then((fs) => fs.mkdir(path.dirname(file), { recursive: true }))
    await writeFile(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
  }

  /** Turns of `per` requests each, every request with one tool result sent after it. */
  function turns(count: number, per: number, linesPerResponse = 1): object[] {
    const out: object[] = []
    let n = 0
    for (let t = 1; t <= count; t++) {
      out.push(prompt(`p${t}`, t, `Turn ${t}`, '2026-11-18T06:00:00.000Z'))
      for (let r = 0; r < per; r++) {
        n++
        out.push(apiRequest(`r${n}`, '2026-11-18T06:00:01.000Z'))
        for (let line = 0; line < linesPerResponse; line++) {
          out.push(
            assistant(
              `r${n}`,
              `msg_${n}`,
              [{ type: 'tool_use', name: 'Read', input: {} }],
              '2026-11-18T06:00:02.000Z',
            ),
          )
        }
        out.push(toolResult(`p${t}`, `result ${n}`, '2026-11-18T06:00:03.000Z'))
      }
    }
    return out
  }

  it('reads the newest page back to the start of a turn, then the page before it', async () => {
    await write(turns(12, 10))
    const size = (await import('node:fs/promises').then((fs) => fs.stat(file))).size
    const newest = parseClaudeTranscript(
      (await readPage(file, size)).lines.map((l) => ({
        start: l.start,
        end: l.end,
        record: JSON.parse(l.bytes.toString()),
      })),
    )
    const counts = newest.turns.map((t) => t.requests.length)
    expect(counts.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(REQUESTS_PAGE)
    expect(counts.every((c) => c === 10)).toBe(true)
    expect(newest.turns[0].prompt).toMatch(/^Turn /)

    const seen: string[] = []
    let end = size
    let pages = 0
    for (;;) {
      const page = await readPage(file, end)
      const ids = parseClaudeTranscript(
        page.lines.map((l) => ({
          start: l.start,
          end: l.end,
          record: JSON.parse(l.bytes.toString()),
        })),
      ).turns.flatMap((t) => t.requests.map((r) => r.id))
      seen.unshift(...ids)
      pages++
      if (page.from === 0) break
      end = page.from
    }
    expect(pages).toBe(3)
    expect(seen).toEqual(Array.from({ length: 120 }, (_, i) => `r${i + 1}`))
  })

  it('counts requests, not the several lines Claude Code writes a response in', async () => {
    await write(turns(10, 10, 3))
    const size = (await import('node:fs/promises').then((fs) => fs.stat(file))).size
    const page = await readPage(file, size)
    const requests = parseClaudeTranscript(
      page.lines.map((l) => ({
        start: l.start,
        end: l.end,
        record: JSON.parse(l.bytes.toString()),
      })),
    ).turns.flatMap((t) => t.requests)
    expect(requests.length).toBeGreaterThanOrEqual(REQUESTS_PAGE)
  })

  it('reads a request as the agent wrote it, with long strings folded unless asked whole', async () => {
    const long = 'x'.repeat(5000)
    await write([
      prompt('p1', 1, 'Hi', '2026-11-18T06:00:00.000Z'),
      apiRequest('r1', '2026-11-18T06:00:01.000Z'),
      assistant('r1', 'msg_1', [{ type: 'text', text: long }], '2026-11-18T06:00:02.000Z'),
    ])
    const reader = claudeModelRequests({ platform: 'darwin', home: dir, env: async () => ({}) })
    const target = {
      agentId: 'claude-code' as const,
      cwd: '/repo',
      acpSessionId: SESSION,
      configDir: dir,
      parentAcpSessionId: null,
    }
    const page = await reader.page(target, null)
    const request = page!.turns[0].requests[0]
    const folded = await reader.raw(target, request.raw, false)
    expect(folded.folded).toBe(true)
    const text = (folded.records[2] as { message: { content: { text: unknown }[] } }).message
      .content[0].text
    expect(foldedBytes(text)).toBe(5000)
    expect(Object.keys(text as object)).toEqual([RAW_FOLDED])
    const whole = await reader.raw(target, request.raw, true)
    expect(JSON.stringify(whole.records)).toContain(long)
    await expect(reader.raw(target, '0-999999999', false)).rejects.toThrow(/changed/)
  })

  it("reads a sub-agent's requests from its parent's session folder", async () => {
    await write([prompt('p1', 1, 'Hi', '2026-11-18T06:00:00.000Z')])
    const child = path.join(
      path.dirname(file),
      SESSION,
      'subagents',
      'agent-a10056f1cc55cec45.jsonl',
    )
    await import('node:fs/promises').then((fs) =>
      fs.mkdir(path.dirname(child), { recursive: true }),
    )
    const sidechain = (record: object) => ({ ...record, isSidechain: true })
    await writeFile(
      child,
      [
        { ...prompt('s1', 1, 'Sweep old icons', '2026-11-18T06:00:01.000Z'), isSidechain: true },
        sidechain(apiRequest('c1', '2026-11-18T06:00:02.000Z')),
        sidechain(
          assistant('c1', 'msg_c1', [{ type: 'text', text: 'Done.' }], '2026-11-18T06:00:03.000Z'),
        ),
      ]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
    )
    const reader = claudeModelRequests({ platform: 'darwin', home: dir, env: async () => ({}) })
    const target = {
      agentId: 'claude-code' as const,
      cwd: '/repo',
      acpSessionId: 'a10056f1cc55cec45',
      configDir: dir,
      parentAcpSessionId: SESSION,
    }
    const page = await reader.page(target, null)
    expect(page!.turns[0].requests.map((r) => r.id)).toEqual(['c1'])
    expect((await reader.summary(target))!.tokens).toMatchObject({ input: 12, output: 80 })
  })

  it('sums up the whole file: requests, the latest cost and how the tools changed', async () => {
    const shape = (tools: string[]) => ({
      type: 'api-request-shape',
      shapeHash: tools.join(),
      timestamp: '2026-11-18T06:00:00.000Z',
      shape: {
        system: [{ type: 'text', text: 'You are Claude Code.' }],
        tools: tools.map((name) => ({ name, description: '', input_schema: {} })),
      },
    })
    await write([
      shape(['Bash', 'Read']),
      ...turns(1, 2),
      { type: 'cost-state', totalCostUSD: 0.5 },
      shape(['Bash', 'Read', 'mcp__github__get_pr']),
      ...turns(1, 1),
      { type: 'cost-state', totalCostUSD: 0.75 },
    ])
    const summary = await summarizeFile(file)
    expect(summary.requests).toBe(3)
    expect(summary.costUsd).toBe(0.75)
    expect(summary.system).toMatchObject({
      blocks: [{ preview: 'You are Claude Code.', chars: 20 }],
      groups: [
        { kind: 'builtin', name: 'builtin', tools: ['Bash', 'Read'] },
        { kind: 'mcp', name: 'github', tools: ['get_pr'] },
      ],
      toolCount: 3,
      changes: [{ added: ['mcp__github__get_pr'], removed: [] }],
    })
  })
})
