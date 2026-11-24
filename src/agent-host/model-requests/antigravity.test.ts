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
})
