import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RAW_FOLDED, REQUESTS_PAGE, foldedBytes } from '@shared/model-requests'
import { folderName } from '../pi/session-files'
import { parsePiTranscript, piModelRequests, summarizePiFile } from './pi'
import type { RequestsTarget } from './reader'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function makeTemp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function writeSession(
  dir: string,
  name: string,
  records: readonly (object | string)[],
): Promise<string> {
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, name)
  await writeFile(
    file,
    records.map((rec) => (typeof rec === 'string' ? rec : JSON.stringify(rec))).join('\n') + '\n',
    'utf8',
  )
  return file
}

function target(
  sessionId: string,
  cwd = '/work/app',
  configDir: string | null = null,
): RequestsTarget {
  return {
    agentId: 'pi',
    cwd,
    acpSessionId: sessionId,
    configDir,
    parentAcpSessionId: null,
  }
}

describe('piModelRequests', () => {
  it('parses turns, per-request tokens, costs, tool calls, system prompt and raw records', async () => {
    const home = await makeTemp('kettu-pi-req-')
    const cwd = '/work/app'
    const sessionId = '01a11111-1111-7111-8111-111111111111'
    const dir = path.join(home, '.pi', 'agent', 'sessions', folderName(cwd))
    const longOutput = 'X'.repeat(6000)

    await writeSession(dir, `2026-11-19T10-00-00-000Z_${sessionId}.jsonl`, [
      { type: 'session', version: 3, id: sessionId, timestamp: '2026-11-19T10:00:00.000Z', cwd },
      {
        type: 'model_change',
        id: 'mc-1',
        parentId: null,
        timestamp: '2026-11-19T10:00:00.100Z',
        provider: 'magpie',
        modelId: 'codex/gpt-6.1-sol',
      },
      {
        type: 'message',
        id: 'sys-1',
        parentId: 'mc-1',
        timestamp: '2026-11-19T10:00:00.200Z',
        message: {
          role: 'system',
          content: '',
          sections: {
            preamble: 'You are Pi.',
            rules: 'Follow repository guidelines.',
          },
          toolsAdded: [
            { name: 'read', description: 'Read file' },
            { name: 'bash', description: 'Run command' },
            { name: 'mcp__kettu__remember', description: 'Save memory' },
          ],
        },
      },
      {
        type: 'message',
        id: 'u-1',
        parentId: 'sys-1',
        timestamp: '2026-11-19T10:00:01.000Z',
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '<skill name="review" location="/tmp/review/SKILL.md">\nbody\n</skill>\n\nCheck notes.txt',
            },
            { type: 'image', mimeType: 'image/png', data: 'AAAA' },
          ],
          timestamp: Date.parse('2026-11-19T10:00:01.000Z'),
        },
      },
      {
        type: 'message',
        id: 'a-1',
        parentId: 'u-1',
        timestamp: '2026-11-19T10:00:05.000Z',
        message: {
          role: 'assistant',
          api: 'openai-responses',
          provider: 'magpie',
          model: 'codex/gpt-6.1-sol',
          content: [
            { type: 'thinking', thinking: 'Inspecting notes.txt first.' },
            { type: 'toolCall', id: 'tc-1', name: 'read', arguments: { path: 'notes.txt' } },
            {
              type: 'toolCall',
              id: 'tc-2',
              name: 'mcp__kettu__remember',
              arguments: { title: 'note' },
            },
          ],
          usage: {
            input: 2000,
            output: 90,
            cacheRead: 1000,
            cacheWrite: 150,
            reasoning: 25,
            totalTokens: 3240,
            cost: { total: 0.0125, totalFromProvider: false },
          },
          stopReason: 'toolUse',
          responseId: 'resp_001',
          timestamp: Date.parse('2026-11-19T10:00:01.500Z'),
          durationMs: 3500,
          thinkingLevel: 'high',
        },
      },
      {
        type: 'message',
        id: 'tr-1',
        parentId: 'a-1',
        timestamp: '2026-11-19T10:00:05.200Z',
        message: {
          role: 'toolResult',
          toolCallId: 'tc-1',
          toolName: 'read',
          content: [{ type: 'text', text: longOutput }],
          isError: false,
        },
      },
      {
        type: 'message',
        id: 'tr-2',
        parentId: 'tr-1',
        timestamp: '2026-11-19T10:00:05.300Z',
        message: {
          role: 'toolResult',
          toolCallId: 'tc-2',
          toolName: 'mcp__kettu__remember',
          content: [{ type: 'text', text: 'Permission denied' }],
          isError: true,
        },
      },
      {
        type: 'message',
        id: 'a-2',
        parentId: 'tr-2',
        timestamp: '2026-11-19T10:00:08.500Z',
        message: {
          role: 'assistant',
          provider: 'magpie',
          model: 'codex/gpt-6.1-sol',
          content: [{ type: 'text', text: 'All checked.' }],
          usage: {
            input: 300,
            output: 40,
            cacheRead: 3100,
            cacheWrite: 0,
            reasoning: 0,
            totalTokens: 3440,
            cost: { total: 0.0025, totalFromProvider: false },
          },
          stopReason: 'stop',
          responseId: 'resp_002',
          timestamp: Date.parse('2026-11-19T10:00:06.000Z'),
          durationMs: 2500,
          thinkingLevel: 'high',
        },
      },
      {
        type: 'message',
        id: 'u-2',
        parentId: 'a-2',
        timestamp: '2026-11-19T10:01:00.000Z',
        message: { role: 'user', content: 'Say hi' },
      },
      {
        type: 'message',
        id: 'a-3',
        parentId: 'u-2',
        timestamp: '2026-11-19T10:01:02.000Z',
        message: {
          role: 'assistant',
          provider: 'magpie',
          model: 'codex/gpt-6.1-sol',
          content: [],
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
          },
          stopReason: 'error',
          errorMessage: '402: Insufficient Balance',
          timestamp: Date.parse('2026-11-19T10:01:01.000Z'),
          durationMs: 1000,
        },
      },
    ])

    const reader = piModelRequests({ platform: 'darwin', home, env: async () => ({}) })
    const t = target(sessionId, cwd)

    const page = await reader.page(t, null)
    expect(page).not.toBeNull()
    expect(page!.source).toBe('pi')
    expect(page!.before).toBeNull()
    expect(page!.turns).toHaveLength(2)

    const [turn1, turn2] = page!.turns
    expect(turn1).toMatchObject({
      id: 'u-1',
      prompt: '/skill:review Check notes.txt',
      startedAt: Date.parse('2026-11-19T10:00:01.000Z'),
    })
    expect(turn1!.requests).toHaveLength(2)

    const [req1, req2] = turn1!.requests
    expect(req1).toMatchObject({
      id: 'a-1',
      turnId: 'u-1',
      sentAt: Date.parse('2026-11-19T10:00:01.500Z'),
      endedAt: Date.parse('2026-11-19T10:00:05.000Z'),
      model: 'codex/gpt-6.1-sol',
      requestId: 'resp_001',
      stop: 'toolUse',
      status: 'done',
      error: null,
      records: 2,
      tokens: {
        input: 2000,
        cacheRead: 1000,
        cacheWrite: 150,
        cacheWrite1h: null,
        output: 90,
        reasoning: 25,
      },
      params: [
        { name: 'provider', value: 'magpie' },
        { name: 'thinking', value: 'high' },
        { name: 'cost', value: '$0.0125' },
      ],
    })
    expect(req1!.sent.map((part) => part.kind)).toEqual(['prompt', 'attachment'])
    expect(req1!.actions).toEqual([
      { kind: 'thinking', label: 'Thinking', count: 1 },
      { kind: 'read', label: 'read notes.txt', count: 1 },
      { kind: 'tool', label: 'remember', count: 1 },
    ])

    expect(req2).toMatchObject({
      id: 'a-2',
      records: 3,
      stop: 'stop',
      status: 'done',
      tokens: {
        input: 300,
        cacheRead: 3100,
        cacheWrite: 0,
        cacheWrite1h: null,
        output: 40,
        reasoning: 0,
      },
    })
    expect(req2!.sent).toMatchObject([
      { kind: 'tool-result', label: 'read' },
      { kind: 'tool-result', label: 'mcp__kettu__remember', error: true },
    ])

    expect(turn2!.id).toBe('u-2')
    expect(turn2!.requests).toHaveLength(1)
    expect(turn2!.requests[0]).toMatchObject({
      id: 'a-3',
      status: 'failed',
      stop: 'error',
      error: '402: Insufficient Balance',
    })

    // Summary agrees with page requests and includes system prompt/tools and turn ordinals.
    const overview = await reader.summary(t)
    expect(overview).toMatchObject({
      source: 'pi',
      requests: 3,
      tokens: {
        input: 2300,
        cacheRead: 4100,
        cacheWrite: 150,
        cacheWrite1h: null,
        output: 130,
        reasoning: 25,
      },
      turns: { 'u-1': 1, 'u-2': 2 },
    })
    expect(overview!.costUsd).toBeCloseTo(0.015, 10)
    expect(overview!.system).toMatchObject({
      kind: 'system',
      toolCount: 3,
      changes: [],
    })
    expect(overview!.system!.blocks).toHaveLength(2)
    expect(overview!.system!.groups).toEqual([
      { kind: 'builtin', name: 'builtin', tools: ['read', 'bash'] },
      { kind: 'mcp', name: 'kettu', tools: ['remember'] },
    ])

    // Raw records: system, folded long strings, and full un-folded reads.
    const sysRaw = await reader.raw(t, 'system', false)
    expect(sysRaw.records).toHaveLength(1)

    const folded = await reader.raw(t, req2!.raw, false)
    expect(folded.records).toHaveLength(3)
    expect(folded.folded).toBe(true)
    const foldedText = (folded.records[0] as { message: { content: { text: unknown }[] } }).message
      .content[0]!.text
    expect(foldedBytes(foldedText)).toBe(6000)
    expect(RAW_FOLDED in (foldedText as object)).toBe(true)

    const full = await reader.raw(t, req2!.raw, true)
    expect(full.folded).toBe(false)
    expect(
      (full.records[0] as { message: { content: { text: string }[] } }).message.content[0]!.text,
    ).toBe(longOutput)

    await expect(reader.raw(t, 'invalid-handle', false)).rejects.toThrow()
  })

  it('keeps missing fields as unknown in legacy Pi session logs', async () => {
    const home = await makeTemp('kettu-pi-req-legacy-')
    const cwd = '/work/legacy'
    const sessionId = 'legacy-session'
    const file = await writeSession(
      path.join(home, '.pi', 'agent', 'sessions', folderName(cwd)),
      `2026-09-01T00-00-00-000Z_${sessionId}.jsonl`,
      [
        { type: 'session', version: 1, id: sessionId, cwd },
        'corrupt line',
        {
          type: 'message',
          timestamp: '2026-09-01T00:00:01.000Z',
          message: { role: 'user', content: 'Hello' },
        },
        {
          type: 'message',
          timestamp: '2026-09-01T00:00:03.000Z',
          message: {
            role: 'assistant',
            content: 'Hi there',
            usage: { input: 50, output: 12 },
          },
        },
      ],
    )

    const reader = piModelRequests({ platform: 'darwin', home, env: async () => ({}) })
    const t = target(sessionId, cwd)
    const page = await reader.page(t, null)
    const summary = await summarizePiFile(file)

    expect(page!.turns).toHaveLength(1)
    const [req] = page!.turns[0]!.requests
    expect(req).toMatchObject({
      model: null,
      requestId: null,
      stop: null,
      params: [],
      status: 'done',
      tokens: {
        input: 50,
        output: 12,
        cacheRead: null,
        cacheWrite: null,
        cacheWrite1h: null,
        reasoning: null,
      },
    })
    expect(summary).toMatchObject({
      source: 'pi',
      requests: 1,
      costUsd: null,
      system: null,
      tokens: {
        input: 50,
        output: 12,
        cacheRead: null,
        cacheWrite: null,
        cacheWrite1h: null,
        reasoning: null,
      },
    })
    // Turn id without explicit entry.id still matches summary's turn ordinal map.
    expect(summary.turns?.[page!.turns[0]!.id]).toBe(1)
  })

  it('paginates sessions with more than REQUESTS_PAGE requests cleanly without gaps or duplicates', async () => {
    const home = await makeTemp('kettu-pi-req-pages-')
    const cwd = '/work/big'
    const sessionId = 'big-session'
    const totalTurns = REQUESTS_PAGE + 15
    const records: object[] = [
      { type: 'session', version: 3, id: sessionId, timestamp: '2026-11-20T00:00:00.000Z', cwd },
    ]
    for (let i = 1; i <= totalTurns; i++) {
      const ts = new Date(Date.parse('2026-11-20T00:00:00.000Z') + i * 2000).toISOString()
      records.push(
        {
          type: 'message',
          id: `u-${i}`,
          parentId: i === 1 ? null : `a-${i - 1}`,
          timestamp: ts,
          message: { role: 'user', content: [{ type: 'text', text: `Prompt ${i}` }] },
        },
        {
          type: 'message',
          id: `a-${i}`,
          parentId: `u-${i}`,
          timestamp: ts,
          message: {
            role: 'assistant',
            model: 'gpt-6.1-sol',
            content: [{ type: 'text', text: `Reply ${i}` }],
            usage: {
              input: 100,
              output: 20,
              cacheRead: 50,
              cacheWrite: 0,
              cost: { total: 0.001, totalFromProvider: false },
            },
            stopReason: 'stop',
          },
        },
      )
    }

    await writeSession(
      path.join(home, '.pi', 'agent', 'sessions', folderName(cwd)),
      `2026-11-20T00-00-00-000Z_${sessionId}.jsonl`,
      records,
    )

    const reader = piModelRequests({ platform: 'darwin', home, env: async () => ({}) })
    const t = target(sessionId, cwd)

    const newest = await reader.page(t, null)
    expect(newest!.before).not.toBeNull()
    const older = await reader.page(t, newest!.before)
    expect(older!.before).toBeNull()

    const combinedRequests = [
      ...older!.turns.flatMap((turn) => turn.requests),
      ...newest!.turns.flatMap((turn) => turn.requests),
    ]
    expect(combinedRequests).toHaveLength(totalTurns)
    expect(new Set(combinedRequests.map((r) => r.id)).size).toBe(totalTurns)

    const overview = await reader.summary(t)
    expect(overview!.requests).toBe(totalTurns)
    expect(overview!.tokens!.input).toBe(totalTurns * 100)
    expect(overview!.tokens!.output).toBe(totalTurns * 20)
    expect(overview!.tokens!.cacheRead).toBe(totalTurns * 50)
    expect(overview!.costUsd).toBeCloseTo(totalTurns * 0.001, 10)
  })

  it('respects target.configDir, PI_CODING_AGENT_DIR, and PI_CODING_AGENT_SESSION_DIR', async () => {
    const home = await makeTemp('kettu-pi-req-dirs-')
    const cwd = '/work/custom'
    const configDir = path.join(home, 'custom-pi-agent')
    const sessionId = 'custom-dir-session'

    await writeSession(
      path.join(configDir, 'sessions', folderName(cwd)),
      `2026-11-20T10-00-00-000Z_${sessionId}.jsonl`,
      [
        { type: 'session', version: 3, id: sessionId, cwd },
        {
          type: 'message',
          id: 'u-c',
          timestamp: '2026-11-20T10:00:01.000Z',
          message: { role: 'user', content: 'Custom dir prompt' },
        },
        {
          type: 'message',
          id: 'a-c',
          timestamp: '2026-11-20T10:00:02.000Z',
          message: {
            role: 'assistant',
            model: 'gpt-6.1-sol',
            content: [{ type: 'text', text: 'OK' }],
            usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
          },
        },
      ],
    )

    const reader = piModelRequests({ platform: 'darwin', home, env: async () => ({}) })
    // Without configDir it is not under default ~/.pi/agent.
    expect(await reader.page(target(sessionId, cwd, null), null)).toBeNull()
    // With target.configDir it finds the session file.
    const page = await reader.page(target(sessionId, cwd, configDir), null)
    expect(page?.turns[0]?.prompt).toBe('Custom dir prompt')

    // With PI_CODING_AGENT_DIR in env it also resolves without target.configDir.
    const envReader = piModelRequests({
      platform: 'darwin',
      home,
      env: async () => ({ PI_CODING_AGENT_DIR: configDir }),
    })
    const envPage = await envReader.page(target(sessionId, cwd, null), null)
    expect(envPage?.turns[0]?.requests[0]?.id).toBe('a-c')

    // Helper sanity check for empty line slices.
    expect(parsePiTranscript([])).toEqual([])
  })
})
