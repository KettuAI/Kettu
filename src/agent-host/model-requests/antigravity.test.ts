import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AcpMessages, acpModelRequests } from './acp-messages'
import { antigravityModelRequests, cleanAgyUserPrompt } from './antigravity'
import type { RequestsTarget } from './reader'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function makeTranscript(
  home: string,
  sessionId: string,
  lines: Record<string, unknown>[],
  fullLines?: Record<string, unknown>[],
) {
  const dir = path.join(
    home,
    '.gemini',
    'antigravity-cli',
    'brain',
    sessionId,
    '.system_generated',
    'logs',
  )
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, 'transcript.jsonl'),
    lines.map((line) => JSON.stringify(line)).join('\n') + '\n',
  )
  if (fullLines) {
    await writeFile(
      path.join(dir, 'transcript_full.jsonl'),
      fullLines.map((line) => JSON.stringify(line)).join('\n') + '\n',
    )
  }
}

function target(sessionId: string): RequestsTarget {
  return {
    agentId: 'antigravity',
    cwd: '/repo',
    acpSessionId: sessionId,
    configDir: null,
    parentAcpSessionId: null,
  }
}

describe('antigravityModelRequests', () => {
  it('清理 USER_INPUT 中的元数据与 Kettu 标签', () => {
    const raw =
      '<USER_REQUEST>\n<kettu-guide>hidden</kettu-guide>帮我看下上下文\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026\n</ADDITIONAL_METADATA>'
    expect(cleanAgyUserPrompt(raw)).toBe('帮我看下上下文')
  })

  it('按轮次与单次 PLANNER_RESPONSE 解析 transcript，支持 summary 与 Raw 全文展开', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'agy-req-'))
    tempDirs.push(home)
    const sessionId = 'conv-123'
    const compact = [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-24T19:29:26Z',
        content: '<USER_REQUEST>\n检查代码\n</USER_REQUEST>',
        media: [{ mime_type: 'image/png', uri: '/tmp/screen.png' }],
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-24T19:29:27Z',
        model: 'gemini-4-neon-xhigh',
        input_tokens: 38_952,
        cache_read_tokens: 0,
        output_tokens: 1_001,
        thinking: 'Checking files...',
        tool_calls: [{ name: 'read_file', args: { Path: '/repo/a.ts' } }],
      },
      {
        step_index: 2,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-24T19:29:46Z',
        content: 'file contents...',
      },
      {
        step_index: 3,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-24T19:29:50Z',
        model: 'gemini-4-neon-xhigh',
        input_tokens: 5_000,
        cache_read_tokens: 38_953,
        output_tokens: 600,
        thinking: 'short...',
        content: '检查完毕。',
        truncated_fields: ['thinking'],
      },
    ]
    const full = compact.map((entry) =>
      entry.step_index === 3
        ? { ...entry, thinking: 'A'.repeat(200), truncated_fields: undefined }
        : entry,
    )
    await makeTranscript(home, sessionId, compact, full)

    const reader = antigravityModelRequests({ home })
    const page = await reader.page(target(sessionId), null)
    expect(page?.source).toBe('antigravity')
    expect(page?.before).toBeNull()
    expect(page?.turns).toHaveLength(1)
    expect(page?.turns[0]).toMatchObject({
      id: 'turn-0',
      prompt: '检查代码',
    })
    expect(page?.turns[0]!.requests).toHaveLength(2)

    const [first, second] = page!.turns[0]!.requests
    expect(first).toMatchObject({
      id: 'step-1',
      model: 'gemini-4-neon-xhigh',
      sentAt: Date.parse('2026-11-24T19:29:27Z'),
      endedAt: Date.parse('2026-11-24T19:29:46Z'),
      tokens: { input: 38_952, cacheRead: 0, output: 1_001 },
      status: 'done',
      records: 2,
    })
    expect(first!.actions).toEqual([
      { kind: 'thinking', label: 'Thinking', count: 1 },
      { kind: 'read', label: 'read_file', count: 1 },
    ])
    expect(first!.sent.map((part) => part.kind)).toEqual(['prompt', 'attachment'])

    expect(second).toMatchObject({
      id: 'step-3',
      tokens: { input: 5_000, cacheRead: 38_953, output: 600 },
      records: 2,
    })
    expect(second!.actions).toEqual([
      { kind: 'thinking', label: 'Thinking', count: 1 },
      { kind: 'reply', label: 'Reply', count: 1 },
    ])

    const summary = await reader.summary(target(sessionId))
    expect(summary).toEqual({
      source: 'antigravity',
      requests: 2,
      costUsd: null,
      tokens: {
        input: 43_952,
        cacheRead: 38_953,
        cacheWrite: null,
        cacheWrite1h: null,
        output: 1_601,
        reasoning: null,
      },
      system: null,
      turns: { 'turn-0': 1 },
    })

    // 折叠读取时保持 transcript.jsonl，展开全文时从 transcript_full.jsonl 补全被截断字段。
    const rawCompact = await reader.raw(target(sessionId), second!.raw, false)
    expect((rawCompact.records[1] as { thinking: string }).thinking).toBe('short...')
    const rawFull = await reader.raw(target(sessionId), second!.raw, true)
    expect((rawFull.records[1] as { thinking: string }).thinking).toBe('A'.repeat(200))
  })

  it('无 transcript 文件时自动回退到 ACP 内存消息读取器', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'agy-req-fallback-'))
    tempDirs.push(home)
    const store = new AcpMessages()
    store.add('antigravity', 'out', {
      jsonrpc: '2.0',
      id: 1,
      method: 'session/prompt',
      params: { sessionId: 'no-file', prompt: [{ type: 'text', text: 'hello' }] },
    })
    store.add('antigravity', 'in', {
      jsonrpc: '2.0',
      id: 1,
      result: { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20 } },
    })
    const reader = antigravityModelRequests({ home, fallback: acpModelRequests(store) })
    const page = await reader.page(target('no-file'), null)
    expect(page?.source).toBe('acp')
    expect(page?.turns).toHaveLength(1)
    const raw = await reader.raw(target('no-file'), page!.turns[0]!.requests[0]!.raw, false)
    expect(raw.records).toHaveLength(2)
  })

  it('从本地 conversations/*.db 补齐思考 token、原生计时与内部重试信息，并纳入 CHECKPOINT 压缩步', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const home = await mkdtemp(path.join(os.tmpdir(), 'agy-req-db-'))
    tempDirs.push(home)
    const sessionId = '33333333-3333-3333-3333-333333333333'
    const logDir = path.join(
      home,
      '.gemini',
      'antigravity-cli',
      'brain',
      sessionId,
      '.system_generated',
      'logs',
    )
    await mkdir(logDir, { recursive: true })
    await writeFile(
      path.join(logDir, 'transcript.jsonl'),
      [
        JSON.stringify({
          step_index: 0,
          type: 'USER_INPUT',
          created_at: '2026-11-25T10:00:00Z',
          content: '优化性能',
        }),
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-11-25T10:00:01Z',
          model: 'gemini-4-neon',
          input_tokens: 1_000,
          cache_read_tokens: 5_000,
          output_tokens: 600,
          content: '已分析',
        }),
        JSON.stringify({
          step_index: 2,
          type: 'CHECKPOINT',
          status: 'DONE',
          created_at: '2026-11-25T10:01:00Z',
          input_tokens: 800,
          cache_read_tokens: 20_000,
          output_tokens: 300,
          content: '# Resuming from a compaction',
        }),
      ].join('\n') + '\n',
    )

    // 构造对应的 conversations/<sessionId>.db，写入思考 token、TTFT、流式时长与重试记录。
    const varint = (v: number): Buffer => {
      let n = BigInt(v)
      const out: number[] = []
      do {
        let b = Number(n & 0x7fn)
        n >>= 7n
        if (n > 0n) b |= 0x80
        out.push(b)
      } while (n > 0n)
      return Buffer.from(out)
    }
    const fV = (f: number, v: number) => Buffer.concat([varint((f << 3) | 0), varint(v)])
    const fB = (f: number, p: Buffer) => Buffer.concat([varint((f << 3) | 2), varint(p.length), p])
    const fS = (f: number, s: string) => fB(f, Buffer.from(s, 'utf8'))

    const convDir = path.join(home, '.gemini', 'antigravity-cli', 'conversations')
    await mkdir(convDir, { recursive: true })
    const db = new DatabaseSync(path.join(convDir, `${sessionId}.db`))
    try {
      db.exec(`
        CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
        CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB);
      `)
      const genChat = Buffer.concat([
        fB(11, Buffer.concat([fV(1, 1), fV(2, 250_000_000)])), // TTFT = 1.25s
        fB(12, Buffer.concat([fV(1, 3), fV(2, 500_000_000)])), // Stream = 3.50s
        fS(19, 'gemini-4-neon'),
      ])
      db.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(10, fB(1, genChat))
      const stepUsage = Buffer.concat([
        fV(2, 1_000),
        fV(3, 600),
        fV(5, 5_000),
        fS(7, 'req-xyz'),
        fV(9, 240),
        fV(10, 360),
      ])
      const retry = Buffer.concat([fS(3, 'overloaded'), fV(5, 429), fB(7, fV(1, 2))])
      const stepMeta = Buffer.concat([
        fB(7, fV(1, Math.floor(Date.parse('2026-11-25T10:00:06Z') / 1000))),
        fB(9, stepUsage),
        fB(20, Buffer.concat([fV(2, 1), fV(3, 10), fS(4, sessionId)])),
        fB(28, retry),
      ])
      db.prepare('INSERT INTO steps VALUES (?, ?, ?, ?)').run(1, 15, 3, stepMeta)
    } finally {
      db.close()
    }

    const reader = antigravityModelRequests({ home })
    const page = await reader.page(target(sessionId), null)
    expect(page?.turns[0]!.requests).toHaveLength(2)

    const [first, compact] = page!.turns[0]!.requests
    expect(first?.tokens.reasoning).toBe(240)
    expect(first?.requestId).toBe('req-xyz')
    expect(first?.endedAt).toBe(Date.parse('2026-11-25T10:00:06Z'))
    expect(first?.params).toEqual([
      { name: 'TTFT', value: '1.25s' },
      { name: 'Stream', value: '3.50s' },
      { name: 'Retries', value: '1 · code 429 · +2.00s' },
    ])

    expect(compact?.model).toBe('gemini-4-neon')
    expect(compact?.actions).toEqual([{ kind: 'tool', label: 'Compaction', count: 1 }])
    expect(compact?.params).toContainEqual({ name: 'type', value: 'compaction' })

    const summary = await reader.summary(target(sessionId))
    expect(summary?.requests).toBe(2)
    expect(summary?.tokens?.reasoning).toBe(240)
  })
})
