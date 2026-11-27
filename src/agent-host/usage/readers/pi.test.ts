import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { piModelRequests } from '../../model-requests/pi'
import { folderName } from '../../pi/session-files'
import { UsageDb } from '../db'
import type { FileCursor, ScanContext, UsageRow } from '../model'
import { piReader } from './pi'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function makeTemp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

async function writeJsonl(file: string, lines: readonly (object | string)[]): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const body =
    lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n'
  await writeFile(file, body, 'utf8')
}

function createScanHarness(
  home: string,
  env: Record<string, string | undefined> = {},
  platform: 'darwin' | 'linux' | 'win32' = 'darwin',
) {
  const cursors = new Map<string, FileCursor>()
  const committed = new Map<string, UsageRow>()
  const warnings: string[] = []
  let commits = 0
  const context: ScanContext = {
    env,
    home,
    platform,
    signal: new AbortController().signal,
    cursor: (id) => cursors.get(id) ?? null,
    commit: (rows, cursor) => {
      commits++
      cursors.set(cursor.id, cursor)
      for (const row of rows) committed.set(row.key, row)
    },
    plan: () => {},
    done: () => {},
    log: (level, message) => {
      if (level === 'warn' || level === 'error') warnings.push(message)
    },
  }
  return {
    context,
    cursors,
    committed,
    warnings,
    get commits() {
      return commits
    },
  }
}

describe('pi usage log reader', () => {
  it('returns false when Pi sessions folder does not exist', async () => {
    const home = await makeTemp('kettu-pi-usage-empty-')
    const harness = createScanHarness(home)
    expect(await piReader.scan(harness.context)).toBe(false)
    expect(harness.committed.size).toBe(0)
  })

  it('parses realistic Pi v3 logs with multiple models, cache read/write, reasoning and confirmed costs', async () => {
    const home = await makeTemp('kettu-pi-usage-v3-')
    const projectA = '/work/alpha'
    const projectB = '/work/beta'
    const sessionsRoot = path.join(home, '.pi', 'agent', 'sessions')

    await writeJsonl(
      path.join(sessionsRoot, folderName(projectA), '2026-11-18T10-00-00-000Z_sess-a.jsonl'),
      [
        {
          type: 'session',
          version: 3,
          id: 'sess-a',
          timestamp: '2026-11-18T10:00:00.000Z',
          cwd: projectA,
        },
        {
          type: 'model_change',
          id: 'mc-1',
          parentId: null,
          timestamp: '2026-11-18T10:00:00.100Z',
          provider: 'gateway',
          modelId: 'codex/gpt-6.1-sol',
        },
        {
          type: 'message',
          id: 'u-1',
          parentId: 'mc-1',
          timestamp: '2026-11-18T10:00:01.000Z',
          message: { role: 'user', content: [{ type: 'text', text: 'Inspect files' }] },
        },
        {
          type: 'message',
          id: 'a-1',
          parentId: 'u-1',
          timestamp: '2026-11-18T10:00:06.614Z',
          message: {
            role: 'assistant',
            api: 'openai-responses',
            provider: 'gateway',
            model: 'codex/gpt-6.1-sol',
            content: [
              { type: 'thinking', thinking: 'Check' },
              { type: 'text', text: 'Done' },
            ],
            usage: {
              input: 9257,
              output: 531,
              cacheRead: 28032,
              cacheWrite: 1200,
              reasoning: 34,
              totalTokens: 39020,
              cost: {
                input: 0.018514,
                output: 0.00531,
                cacheRead: 0.0028032,
                cacheWrite: 0.0012,
                total: 0.0278272,
                totalFromProvider: false,
              },
            },
            stopReason: 'stop',
            timestamp: 1794996001000,
            durationMs: 5614,
          },
        },
        // Aborted 0-token assistant message should not create a usage row.
        {
          type: 'message',
          id: 'a-abort',
          parentId: 'a-1',
          timestamp: '2026-11-18T10:01:00.000Z',
          message: {
            role: 'assistant',
            provider: 'gateway',
            model: 'codex/gpt-6.1-sol',
            content: [],
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { total: 0, totalFromProvider: false },
            },
            stopReason: 'aborted',
            errorMessage: 'This operation was aborted',
          },
        },
      ],
    )

    // Second project with provider-confirmed zero cost and unpriced zero cost.
    await writeJsonl(
      path.join(sessionsRoot, folderName(projectB), '2026-11-19T08-00-00-000Z_sess-b.jsonl'),
      [
        {
          type: 'session',
          version: 3,
          id: 'sess-b',
          timestamp: '2026-11-19T08:00:00.000Z',
          cwd: projectB,
        },
        {
          type: 'message',
          id: 'b-1',
          parentId: null,
          timestamp: '2026-11-19T08:00:05.000Z',
          message: {
            role: 'assistant',
            provider: 'gateway',
            model: 'auto/deepseek-v4.1-flash',
            content: [{ type: 'text', text: 'ok' }],
            usage: {
              input: 8162,
              output: 305,
              cacheRead: 0,
              cacheWrite: 0,
              reasoning: 195,
              totalTokens: 8467,
              cost: { total: 0, totalFromProvider: false },
            },
            stopReason: 'stop',
          },
        },
        {
          type: 'message',
          id: 'b-2',
          parentId: 'b-1',
          timestamp: '2026-11-19T08:01:05.000Z',
          message: {
            role: 'assistant',
            provider: 'local',
            model: 'custom/free-model',
            content: [{ type: 'text', text: 'free' }],
            usage: {
              input: 400,
              output: 100,
              cacheRead: 50,
              cacheWrite: 0,
              totalTokens: 550,
              cost: { total: 0, totalFromProvider: true },
            },
            stopReason: 'stop',
          },
        },
      ],
    )

    const harness = createScanHarness(home)
    expect(await piReader.scan(harness.context)).toBe(true)
    expect(harness.warnings).toEqual([])
    expect(harness.committed.size).toBe(3)

    const rowA = harness.committed.get(`pi:a-1:${Date.parse('2026-11-18T10:00:06.614Z')}`)
    expect(rowA).toMatchObject({
      source: 'log',
      agentId: 'pi',
      sessionId: 'sess-a',
      project: projectA,
      model: 'gpt-6.1-sol',
      input: 9257,
      output: 531,
      reasoning: null,
      cacheRead: 28032,
      cacheWrite: 1200,
      cacheWrite1h: 0,
      turn: 0,
      cost: 0.0278272,
    })

    const rowB1 = harness.committed.get(`pi:b-1:${Date.parse('2026-11-19T08:00:05.000Z')}`)
    expect(rowB1).toMatchObject({
      sessionId: 'sess-b',
      project: projectB,
      model: 'deepseek-v4.1-flash',
      input: 8162,
      output: 305,
      reasoning: null,
      cacheRead: 0,
      cacheWrite: 0,
      // cost.total === 0 with totalFromProvider: false is treated as unknown (null).
      cost: null,
    })

    const rowB2 = harness.committed.get(`pi:b-2:${Date.parse('2026-11-19T08:01:05.000Z')}`)
    expect(rowB2).toMatchObject({
      sessionId: 'sess-b',
      project: projectB,
      model: 'free-model',
      input: 400,
      output: 100,
      cacheRead: 50,
      // Provider explicitly confirmed $0 cost.
      cost: 0,
    })

    // Unchanged files are skipped by mtime/size cursor on a second scan.
    const beforeCommits = harness.commits
    expect(await piReader.scan(harness.context)).toBe(true)
    expect(harness.commits).toBe(beforeCommits)
  })

  it('handles older logs with missing fields as unknown and tolerates malformed or truncated lines', async () => {
    const home = await makeTemp('kettu-pi-usage-legacy-')
    const file = path.join(home, '.pi', 'agent', 'sessions', 'legacy-sess.jsonl')
    await mkdir(path.dirname(file), { recursive: true })

    // Missing cwd in header, missing cost/reasoning/model/id on entries, malformed JSON and
    // an incomplete trailing line without a newline.
    const rawLines = [
      JSON.stringify({ type: 'session', version: 1, id: 'legacy-1' }),
      'not valid json {{{',
      JSON.stringify({
        type: 'message',
        timestamp: '2026-10-01T12:00:00.000Z',
        message: {
          role: 'assistant',
          model: 'unknown/unknown',
          usage: { input: 250, output: 50 },
        },
      }),
      JSON.stringify({
        type: 'model_change',
        id: 'mc-legacy',
        modelId: 'anthropic/claude-sonnet-4-5-20250929',
      }),
      JSON.stringify({
        type: 'message',
        id: 'a-fallback-model',
        timestamp: '2026-10-01T12:05:00.000Z',
        message: {
          role: 'assistant',
          // No model field on message; falls back to model_change.
          usage: { input: 100, output: 20, cacheRead: 500, totalTokens: 620 },
        },
      }),
    ]
    const trailingTruncated = '{"type":"message","id":"partial","message":{"role":"assistant"'
    await writeFile(file, `${rawLines.join('\n')}\n${trailingTruncated}`, 'utf8')

    const harness = createScanHarness(home)
    expect(await piReader.scan(harness.context)).toBe(true)
    expect(harness.warnings).toEqual([])
    expect(harness.committed.size).toBe(2)

    const rows = [...harness.committed.values()]
    const unknownModelRow = rows.find((r) => r.input === 250)!
    expect(unknownModelRow).toMatchObject({
      sessionId: 'legacy-1',
      project: null,
      model: '',
      input: 250,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
      cost: null,
    })

    const fallbackRow = rows.find((r) => r.input === 100)!
    expect(fallbackRow).toMatchObject({
      sessionId: 'legacy-1',
      project: null,
      model: 'claude-sonnet-4-5',
      input: 100,
      output: 20,
      cacheRead: 500,
      cacheWrite: 0,
      cost: null,
    })

    // Completing the truncated line and appending another resumes from the saved cursor while
    // retaining header sessionId/project and the prior model_change.
    const completed = JSON.stringify({
      type: 'message',
      id: 'a-appended',
      timestamp: '2026-10-01T12:10:00.000Z',
      message: {
        role: 'assistant',
        usage: { input: 300, output: 40, cacheRead: 600, cacheWrite: 10 },
      },
    })
    await writeFile(file, `${rawLines.join('\n')}\n${completed}\n`, 'utf8')
    const later = new Date(Date.now() + 2_000)
    await utimes(file, later, later)

    expect(await piReader.scan(harness.context)).toBe(true)
    expect(harness.committed.size).toBe(3)
    const appended = harness.committed.get(
      `pi:a-appended:${Date.parse('2026-10-01T12:10:00.000Z')}`,
    )
    expect(appended).toMatchObject({
      sessionId: 'legacy-1',
      project: null,
      model: 'claude-sonnet-4-5',
      input: 300,
      output: 40,
      cacheRead: 600,
      cacheWrite: 10,
      cost: null,
    })
  })

  it('respects PI_CODING_AGENT_DIR, settings.json sessionDir, and PI_CODING_AGENT_SESSION_DIR', async () => {
    const home = await makeTemp('kettu-pi-usage-env-')
    const customAgentDir = path.join(home, 'profiles', 'work-pi')
    const settingsSessions = path.join(customAgentDir, 'custom-sessions')
    const envSessions = path.join(home, 'override-sessions')

    const makeSession = (id: string, cwd: string, entryId: string, tokensIn: number) => [
      { type: 'session', version: 3, id, timestamp: '2026-11-20T10:00:00.000Z', cwd },
      {
        type: 'message',
        id: entryId,
        timestamp: '2026-11-20T10:00:05.000Z',
        message: {
          role: 'assistant',
          model: 'gpt-6.1-sol',
          usage: { input: tokensIn, output: 10, cacheRead: 0, cacheWrite: 0 },
        },
      },
    ]

    await writeJsonl(
      path.join(customAgentDir, 'sessions', 'a.jsonl'),
      makeSession('default-in-agent', '/repo/agent', 'e-agent', 111),
    )
    await writeJsonl(
      path.join(settingsSessions, 'b.jsonl'),
      makeSession('from-settings', '/repo/settings', 'e-settings', 222),
    )
    await writeJsonl(
      path.join(envSessions, 'c.jsonl'),
      makeSession('from-env', '/repo/env', 'e-env', 333),
    )

    // 1. PI_CODING_AGENT_DIR without settings.json reads <agentDir>/sessions.
    const env1 = { PI_CODING_AGENT_DIR: customAgentDir }
    expect(piReader.locations(env1, home)).toEqual([path.join(customAgentDir, 'sessions')])
    const h1 = createScanHarness(home, env1)
    expect(await piReader.scan(h1.context)).toBe(true)
    expect([...h1.committed.values()].map((r) => r.input)).toEqual([111])

    // 2. settings.json sessionDir overrides <agentDir>/sessions.
    await writeFile(
      path.join(customAgentDir, 'settings.json'),
      JSON.stringify({ sessionDir: 'custom-sessions' }),
      'utf8',
    )
    expect(piReader.locations(env1, home)).toEqual([settingsSessions])
    const h2 = createScanHarness(home, env1)
    expect(await piReader.scan(h2.context)).toBe(true)
    expect([...h2.committed.values()].map((r) => r.input)).toEqual([222])

    // 3. PI_CODING_AGENT_SESSION_DIR overrides settings.json.
    const env3 = { ...env1, PI_CODING_AGENT_SESSION_DIR: envSessions }
    expect(piReader.locations(env3, home)).toEqual([envSessions])
    const h3 = createScanHarness(home, env3)
    expect(await piReader.scan(h3.context)).toBe(true)
    expect([...h3.committed.values()].map((r) => r.input)).toEqual([333])
  })

  it('deduplicates copied history entries when a Pi session is forked', async () => {
    const home = await makeTemp('kettu-pi-usage-fork-')
    const dir = path.join(home, '.pi', 'agent', 'sessions', folderName('/work/repo'))
    const shared = {
      type: 'message',
      id: 'shared-1',
      timestamp: '2026-11-20T12:00:05.000Z',
      message: {
        role: 'assistant',
        model: 'gpt-6.1-sol',
        usage: { input: 500, output: 100, cacheRead: 1000, cacheWrite: 0, cost: { total: 0.01 } },
      },
    }
    await writeJsonl(path.join(dir, '2026-11-20T12-00-00-000Z_parent.jsonl'), [
      {
        type: 'session',
        version: 3,
        id: 'parent',
        timestamp: '2026-11-20T12:00:00.000Z',
        cwd: '/work/repo',
      },
      shared,
    ])
    await writeJsonl(path.join(dir, '2026-11-20T12-05-00-000Z_child.jsonl'), [
      {
        type: 'session',
        version: 3,
        id: 'child',
        timestamp: '2026-11-20T12:05:00.000Z',
        cwd: '/work/repo',
        parentSession: 'parent.jsonl',
      },
      shared,
      {
        type: 'message',
        id: 'child-only',
        timestamp: '2026-11-20T12:06:00.000Z',
        message: {
          role: 'assistant',
          model: 'gpt-6.1-sol',
          usage: { input: 200, output: 50, cacheRead: 1500, cacheWrite: 0, cost: { total: 0.005 } },
        },
      },
    ])

    const db = UsageDb.open(path.join(home, 'usage.db'), () => {})
    try {
      const scanCtx: ScanContext = {
        env: {},
        home,
        platform: 'darwin',
        signal: new AbortController().signal,
        cursor: (id) => db.cursor(id),
        commit: (rows, cursor) => {
          db.write(rows, cursor)
        },
        plan: () => {},
        done: () => {},
        log: () => {},
      }
      expect(await piReader.scan(scanCtx)).toBe(true)
      const totals = db.totals(
        Date.parse('2026-11-20T00:00:00.000Z'),
        Date.parse('2026-11-21T00:00:00.000Z'),
        { pi: 'log' },
      )
      expect(totals).toHaveLength(1)
      expect(totals[0]).toMatchObject({
        agentId: 'pi',
        requests: 2,
        input: 700,
        output: 150,
        cacheRead: 2500,
        cacheWrite: 0,
      })
      expect(totals[0]!.cost).toBeCloseTo(0.015, 10)
    } finally {
      db.close()
    }
  })

  it('matches global UsageDb aggregates (by day, model, project and total) with per-session modelRequests details', async () => {
    const home = await makeTemp('kettu-pi-consistency-')
    const sessionsRoot = path.join(home, '.pi', 'agent', 'sessions')
    const projectAlpha = '/repo/alpha'
    const projectBeta = '/repo/beta'

    const sessionAlpha = '01a10000-0000-7000-8000-000000000001'
    const sessionBeta = '01a10000-0000-7000-8000-000000000002'

    // Session Alpha: two models on day 1, including a custom gateway model not in prices.json
    // with confirmed log cost, and cache read/write tokens.
    await writeJsonl(
      path.join(
        sessionsRoot,
        folderName(projectAlpha),
        `2026-11-20T09-00-00-000Z_${sessionAlpha}.jsonl`,
      ),
      [
        {
          type: 'session',
          version: 3,
          id: sessionAlpha,
          timestamp: '2026-11-20T09:00:00.000Z',
          cwd: projectAlpha,
        },
        {
          type: 'message',
          id: 'u-a1',
          parentId: null,
          timestamp: '2026-11-20T09:00:01.000Z',
          message: { role: 'user', content: [{ type: 'text', text: 'Read and fix' }] },
        },
        {
          type: 'message',
          id: 'req-a1',
          parentId: 'u-a1',
          timestamp: '2026-11-20T09:00:06.000Z',
          message: {
            role: 'assistant',
            provider: 'magpie',
            model: 'codex/gpt-6.1-sol',
            content: [
              { type: 'toolCall', id: 'tc-1', name: 'read', arguments: { path: 'index.ts' } },
            ],
            usage: {
              input: 12000,
              output: 120,
              cacheRead: 4000,
              cacheWrite: 500,
              reasoning: 30,
              totalTokens: 16620,
              cost: { total: 0.0315, totalFromProvider: false },
            },
            stopReason: 'toolUse',
            timestamp: Date.parse('2026-11-20T09:00:02.000Z'),
            durationMs: 4000,
          },
        },
        {
          type: 'message',
          id: 'tr-a1',
          parentId: 'req-a1',
          timestamp: '2026-11-20T09:00:07.000Z',
          message: {
            role: 'toolResult',
            toolCallId: 'tc-1',
            toolName: 'read',
            content: [{ type: 'text', text: 'export const ok = true' }],
            isError: false,
          },
        },
        {
          type: 'message',
          id: 'req-a2',
          parentId: 'tr-a1',
          timestamp: '2026-11-20T09:00:12.000Z',
          message: {
            role: 'assistant',
            provider: 'custom-gw',
            model: 'private/internal-coder-v9',
            content: [{ type: 'text', text: 'Fixed' }],
            usage: {
              input: 3500,
              output: 240,
              cacheRead: 16000,
              cacheWrite: 0,
              reasoning: 80,
              totalTokens: 19740,
              cost: { total: 0.0185, totalFromProvider: true },
            },
            stopReason: 'stop',
            timestamp: Date.parse('2026-11-20T09:00:08.000Z'),
            durationMs: 4000,
          },
        },
      ],
    )

    // Session Beta: day 2, second project, with confirmed cost.
    await writeJsonl(
      path.join(
        sessionsRoot,
        folderName(projectBeta),
        `2026-11-21T14-00-00-000Z_${sessionBeta}.jsonl`,
      ),
      [
        {
          type: 'session',
          version: 3,
          id: sessionBeta,
          timestamp: '2026-11-21T14:00:00.000Z',
          cwd: projectBeta,
        },
        {
          type: 'message',
          id: 'u-b1',
          parentId: null,
          timestamp: '2026-11-21T14:00:01.000Z',
          message: { role: 'user', content: [{ type: 'text', text: 'Summarize' }] },
        },
        {
          type: 'message',
          id: 'req-b1',
          parentId: 'u-b1',
          timestamp: '2026-11-21T14:00:04.000Z',
          message: {
            role: 'assistant',
            provider: 'magpie',
            model: 'auto/deepseek-v4.1-flash',
            content: [{ type: 'text', text: 'Summary ready.' }],
            usage: {
              input: 4500,
              output: 180,
              cacheRead: 2000,
              cacheWrite: 300,
              reasoning: 40,
              totalTokens: 6980,
              cost: { total: 0.0042, totalFromProvider: false },
            },
            stopReason: 'stop',
            timestamp: Date.parse('2026-11-21T14:00:01.500Z'),
            durationMs: 2500,
          },
        },
      ],
    )

    // 1. Scan via piReader into UsageDb.
    const db = UsageDb.open(path.join(home, 'usage.db'), () => {})
    try {
      const scanCtx: ScanContext = {
        env: {},
        home,
        platform: 'darwin',
        signal: new AbortController().signal,
        cursor: (id) => db.cursor(id),
        commit: (rows, cursor) => {
          db.write(rows, cursor)
        },
        plan: () => {},
        done: () => {},
        log: () => {},
      }
      expect(await piReader.scan(scanCtx)).toBe(true)

      const day0 = Date.parse('2026-11-20T00:00:00.000Z')
      const day1 = Date.parse('2026-11-21T00:00:00.000Z')
      const day2 = Date.parse('2026-11-22T00:00:00.000Z')
      const summary = db.summary([day0, day1, day2], day0, day2, { pi: 'log' })
      const [dbTotal] = db.totals(day0, day2, { pi: 'log' })

      // 2. Read per-session breakdowns via piModelRequests.
      const requestsReader = piModelRequests({
        platform: 'darwin',
        home,
        env: async () => ({}),
      })
      const targetA = {
        agentId: 'pi' as const,
        cwd: projectAlpha,
        acpSessionId: sessionAlpha,
        configDir: null,
        parentAcpSessionId: null,
      }
      const targetB = {
        agentId: 'pi' as const,
        cwd: projectBeta,
        acpSessionId: sessionBeta,
        configDir: null,
        parentAcpSessionId: null,
      }
      const [pageA, overA, pageB, overB] = await Promise.all([
        requestsReader.page(targetA, null),
        requestsReader.summary(targetA),
        requestsReader.page(targetB, null),
        requestsReader.summary(targetB),
      ])

      const allSessionRequests = [
        ...pageA!.turns.flatMap((t) => t.requests),
        ...pageB!.turns.flatMap((t) => t.requests),
      ]

      const detailInput = allSessionRequests.reduce((s, r) => s + (r.tokens.input ?? 0), 0)
      const detailOutput = allSessionRequests.reduce((s, r) => s + (r.tokens.output ?? 0), 0)
      const detailCacheRead = allSessionRequests.reduce((s, r) => s + (r.tokens.cacheRead ?? 0), 0)
      const detailCacheWrite = allSessionRequests.reduce(
        (s, r) => s + (r.tokens.cacheWrite ?? 0),
        0,
      )
      const detailCost = (overA!.costUsd ?? 0) + (overB!.costUsd ?? 0)

      // Global UsageDb totals match per-session details exactly.
      expect(dbTotal).toBeDefined()
      expect(dbTotal!.requests).toBe(allSessionRequests.length)
      expect(dbTotal!.requests).toBe((overA!.requests ?? 0) + (overB!.requests ?? 0))
      expect(dbTotal!.input).toBe(detailInput)
      expect(dbTotal!.output).toBe(detailOutput)
      expect(dbTotal!.cacheRead).toBe(detailCacheRead)
      expect(dbTotal!.cacheWrite).toBe(detailCacheWrite)
      expect(dbTotal!.reasoning).toBe(0)
      expect(dbTotal!.unpricedTokens).toBe(0)
      expect(dbTotal!.cost).toBeCloseTo(detailCost, 10)

      // By-day totals match session A (day 0) and session B (day 1).
      const byDay0 = summary.days.find((d) => d.day === 0 && d.agentId === 'pi')!
      const byDay1 = summary.days.find((d) => d.day === 1 && d.agentId === 'pi')!
      expect(byDay0.input).toBe(overA!.tokens!.input)
      expect(byDay0.output).toBe(overA!.tokens!.output)
      expect(byDay0.cacheRead).toBe(overA!.tokens!.cacheRead)
      expect(byDay0.cacheWrite).toBe(overA!.tokens!.cacheWrite)
      expect(byDay0.cost).toBeCloseTo(overA!.costUsd!, 10)
      expect(byDay1.input).toBe(overB!.tokens!.input)
      expect(byDay1.output).toBe(overB!.tokens!.output)
      expect(byDay1.cost).toBeCloseTo(overB!.costUsd!, 10)

      // By-project totals match each project's session exactly.
      const projA = summary.projects.find((p) => p.project === projectAlpha)!
      const projB = summary.projects.find((p) => p.project === projectBeta)!
      expect(projA.requests).toBe(overA!.requests)
      expect(projA.cost).toBeCloseTo(overA!.costUsd!, 10)
      expect(projB.requests).toBe(overB!.requests)
      expect(projB.cost).toBeCloseTo(overB!.costUsd!, 10)

      // By-model breakdown includes all three normalized models with exact costs.
      const byModel = new Map(summary.models.map((m) => [m.model, m]))
      expect(byModel.get('gpt-6.1-sol')?.cost).toBeCloseTo(0.0315, 10)
      expect(byModel.get('internal-coder-v9')?.cost).toBeCloseTo(0.0185, 10)
      expect(byModel.get('internal-coder-v9')?.unpricedTokens).toBe(0)
      expect(byModel.get('deepseek-v4.1-flash')?.cost).toBeCloseTo(0.0042, 10)
    } finally {
      db.close()
    }
  })
})
