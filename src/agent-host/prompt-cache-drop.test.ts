import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentAccount } from '@shared/agent-host'
import type { ConfigOption, SessionView, StopReason, TokenTotals } from '@shared/thread'
import type { AgentManager } from './agents'
import type { ModelTokens, PromptResult, SessionTarget } from './connection'
import { Diagnostics } from './diagnostics'
import type { Projects } from './projects'
import type { ScratchFolders } from './scratch'
import { SessionManager, type SessionEvents } from './sessions'
import { returnedFile, sessionsFile } from './storage'

const MINUTE = 60_000

let dir: string
const managers: SessionManager[] = []

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'kettu-cache-drop-'))
})

afterEach(async () => {
  const created = managers.splice(0)
  for (const sessions of created) sessions.shutdown()
  await Promise.all(created.map((sessions) => sessions.flush()))
  await rm(dir, { recursive: true, force: true })
})

const log = () => {}

interface ScriptedTurn {
  /** Side effects emitted into the session target before the turn settles. */
  during?: (target: SessionTarget, advance: (ms: number) => void) => void
  result: PromptResult
}

function modelConfig(value: string): ConfigOption[] {
  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      value,
      choices: [
        { value: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
        { value: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
        { value: 'gemini-4-neon', name: 'Gemini 4 Neon' },
        { value: 'custom-unpriced-model', name: 'Custom Model' },
      ],
    },
  ]
}

async function setupHarness(options: {
  agentId?: 'claude-code' | 'antigravity' | 'opencode'
  initialModel?: string
  account?: AgentAccount | null
  turns: ScriptedTurn[]
}) {
  const repo = path.join(dir, 'repo')
  await mkdir(repo, { recursive: true })
  let clock = 1_700_000_000_000
  const advance = (ms: number) => {
    clock += ms
  }
  let config = modelConfig(options.initialModel ?? 'claude-sonnet-4-6')
  const targets = new Map<string, SessionTarget>()
  const queue = [...options.turns]

  const connection = {
    isClosed: false,
    closed: new Promise<void>(() => {}),
    register: (acpId: string, target: SessionTarget) => {
      targets.set(acpId, target)
    },
    unregister: (acpId: string) => {
      targets.delete(acpId)
    },
    reopen: () => {},
    newSession: async () => ({ sessionId: 'acp-1', config }),
    setConfigOption: async (_acpId: string, optionId: string, value: string | boolean) => {
      config = config.map((opt) => (opt.id === optionId ? { ...opt, value } : opt))
      return config
    },
    prompt: async (acpId: string): Promise<PromptResult> => {
      const next = queue.shift()
      if (!next) throw new Error('Unexpected prompt call')
      const target = targets.get(acpId)
      if (target && next.during) next.during(target, advance)
      return next.result
    },
    cancel: async () => {},
    closeSession: async () => {},
  }
  const runtime = {
    init: {
      name: 'Agent',
      version: '1.0.0',
      capabilities: {
        loadSession: false,
        listSessions: false,
        resumeSession: false,
        closeSession: true,
        deleteSession: false,
        forkSession: false,
        forkAtMessage: false,
        ownTitles: 'sent' as const,
        logout: false,
        steering: false,
        mcpHttp: false,
        mcpSse: false,
        mcpStdio: false,
        prompt: { image: false, audio: false, embeddedContext: false },
      },
      authMethods: [],
      raw: {},
    },
    connection,
  }
  const agents = {
    has: () => true,
    name: () => 'Agent',
    isDisabled: () => false,
    assertEnabled: () => {},
    signedIn: () => {},
    authRequired: () => {},
    runningConfig: () => null,
    sessionsChanged: () => {},
    restoreConfig: (_agentId: string, c: ConfigOption[]) => c,
    status: () => ({
      capabilities: runtime.init.capabilities,
      limits: [],
      account: options.account ?? null,
    }),
    whileOpening: (_agentId: string, start: Promise<unknown>) => start,
    hasContext: () => false,
    refreshLimits: async () => {},
    runtime: () => runtime,
    ensureReady: async () => runtime,
  } as unknown as AgentManager

  const sessions = new SessionManager({
    platform: 'darwin',
    agents,
    projects: {
      list: () => [],
      resolveDirectory: async (folder: string) => folder,
      add: async () => {},
    } as unknown as Projects,
    scratch: { contains: () => false } as unknown as ScratchFolders,
    file: sessionsFile(dir, log),
    returned: returnedFile(dir, log),
    portOpen: () => false,
    threads: null,
    reportsDir: path.join(dir, 'reports'),
    diagnostics: new Diagnostics(),
    git: () => null,
    events: new Proxy(
      {},
      {
        get: (target, prop) => Reflect.get(target, prop) ?? (() => {}),
      },
    ) as unknown as SessionEvents,
    settings: () => ({ startModes: {}, promptSuggestions: false, sessionTitles: false }) as never,
    now: () => clock,
  })
  managers.push(sessions)
  await sessions.load()
  const created = await sessions.create({
    agentId: options.agentId ?? 'claude-code',
    projectPath: repo,
  })

  const send = async (text: string): Promise<SessionView> => {
    await sessions.prompt(created.id, [{ type: 'text', text }])
    // Wait for runTurn to settle into ready state.
    for (let i = 0; i < 50; i++) {
      const current = (await sessions.snapshot(created.id)).session
      if (current.status === 'ready') return current
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return (await sessions.snapshot(created.id)).session
  }

  return { sessions, sessionId: created.id, send, advance }
}

function emitRequest(
  target: SessionTarget,
  opts: { used: number; ttl?: number | null; cacheRead?: number; cacheWrite?: number },
): void {
  const ctx = target.context()
  const prev = ctx.thread.session.usage
  target.apply({
    patches: [
      {
        op: 'session.update',
        changes: {
          usage: {
            used: opts.used,
            size: 200_000,
            cost: prev?.cost ?? null,
            tokens: prev?.tokens ?? null,
            cache: { lastRequestAt: ctx.now, ttl: opts.ttl ?? prev?.cache?.ttl ?? null },
          },
        },
      },
    ],
    effects: [
      {
        kind: 'request',
        ...(opts.cacheRead !== undefined || opts.cacheWrite !== undefined
          ? { cache: { read: opts.cacheRead ?? 0, written: opts.cacheWrite ?? 0 } }
          : {}),
      },
    ],
  })
}

function makeTokens(
  input: number,
  cacheRead: number | null,
  cacheWrite: number | null = 0,
): TokenTotals {
  return {
    total: input + (cacheRead ?? 0) + (cacheWrite ?? 0) + 200,
    input,
    output: 200,
    thought: null,
    cacheRead,
    cacheWrite,
  }
}

function resultOf(
  tokens: TokenTotals | null,
  model?: string,
  stopReason: StopReason = 'end_turn',
): PromptResult {
  const models: ModelTokens[] = tokens && model ? [{ model, tokens }] : []
  return { stopReason, tokens, models }
}

describe('SessionManager post-turn prompt cache drop detection (#2810)', () => {
  it('never false-triggers on cold first turn, steady high hit rates, or agents without cacheRead data', async () => {
    const { send } = await setupHarness({
      turns: [
        // Turn 1: cold start (0% hit) — no baseline yet
        {
          during: (t) => emitRequest(t, { used: 30_000, ttl: 5 * MINUTE }),
          result: resultOf(makeTokens(0, 0, 30_000), 'claude-sonnet-4-6'),
        },
        // Turn 2: warm cache (92% hit)
        {
          during: (t) => emitRequest(t, { used: 35_000, ttl: 5 * MINUTE }),
          result: resultOf(makeTokens(500, 32_200, 2_300), 'claude-sonnet-4-6'),
        },
        // Turn 3: still warm (88% hit)
        {
          during: (t) => emitRequest(t, { used: 40_000, ttl: 5 * MINUTE }),
          result: resultOf(makeTokens(800, 35_200, 4_000), 'claude-sonnet-4-6'),
        },
        // Turn 4: agent stops reporting cacheRead (null) — skipped, no false alert
        {
          during: (t) => emitRequest(t, { used: 42_000, ttl: 5 * MINUTE }),
          result: resultOf(makeTokens(42_000, null, null), 'claude-sonnet-4-6'),
        },
      ],
    })

    expect((await send('turn 1')).cacheDrop).toBeNull()
    expect((await send('turn 2')).cacheDrop).toBeNull()
    expect((await send('turn 3')).cacheDrop).toBeNull()
    expect((await send('turn 4')).cacheDrop).toBeNull()
  })

  it('detects a real cache hit drop with measured values, model-change reason, and API extra cost, and clears on the next turn', async () => {
    const { sessions, sessionId, send, advance } = await setupHarness({
      initialModel: 'claude-sonnet-4-6',
      turns: [
        // Turn 1: warm baseline on Sonnet (90% of 40K)
        {
          during: (t) => emitRequest(t, { used: 40_000, ttl: 5 * MINUTE }),
          result: resultOf(makeTokens(1_000, 36_000, 3_000), 'claude-sonnet-4-6'),
        },
        // Turn 2: switched to Opus within TTL -> 0% cache hit
        {
          during: (t) => emitRequest(t, { used: 40_000, ttl: 5 * MINUTE }),
          result: resultOf(makeTokens(0, 0, 40_000), 'claude-opus-4-6'),
        },
        // Turn 3: warm again on Opus -> clears cacheDrop
        {
          during: (t) => emitRequest(t, { used: 44_000, ttl: 5 * MINUTE }),
          result: resultOf(makeTokens(1_000, 41_000, 2_000), 'claude-opus-4-6'),
        },
      ],
    })

    expect((await send('turn 1')).cacheDrop).toBeNull()
    advance(30_000) // Still within 5-minute TTL
    await sessions.setConfigOption(sessionId, 'model', 'claude-opus-4-6')
    const afterDrop = await send('turn 2')
    expect(afterDrop.cacheDrop).toMatchObject({
      baselineShare: 0.9,
      currentShare: 0,
      baselineCacheRead: 36_000,
      currentCacheRead: 0,
      currentTotalInput: 40_000,
      missedTokens: 40_000,
      reason: 'model_changed',
    })
    // Opus 4.6: 36K lost cache tokens * ($6.25 - $0.50) / 1M = $0.207
    expect(afterDrop.cacheDrop?.extraCostUsd).toBeCloseTo(0.207, 4)

    advance(30_000)
    const afterRecover = await send('turn 3')
    expect(afterRecover.cacheDrop).toBeNull()
  })

  it('deduplicates when cache was already known to be expired before sending', async () => {
    const { send, advance } = await setupHarness({
      turns: [
        // Turn 1: warm baseline with 5m TTL and 40K context (>= CACHE_NOTICE_MIN_TOKENS)
        {
          during: (t) => emitRequest(t, { used: 40_000, ttl: 5 * MINUTE }),
          result: resultOf(makeTokens(1_000, 36_000, 3_000), 'claude-sonnet-4-6'),
        },
        // Turn 2: sent 8 minutes later (past known 5m expiry) -> pre-send notice already covered it
        {
          during: (t) => emitRequest(t, { used: 42_000, ttl: 5 * MINUTE }),
          result: resultOf(makeTokens(0, 0, 42_000), 'claude-sonnet-4-6'),
        },
      ],
    })

    expect((await send('turn 1')).cacheDrop).toBeNull()
    advance(8 * MINUTE)
    expect((await send('turn 2')).cacheDrop).toBeNull()
  })

  it('records verifiable compaction and mid-turn TTL expiry reasons, and omits reason/cost when unverifiable', async () => {
    const { send, advance } = await setupHarness({
      agentId: 'antigravity',
      initialModel: 'custom-unpriced-model',
      turns: [
        // Turn 1: warm baseline on unpriced model without fixed TTL
        {
          during: (t) => emitRequest(t, { used: 50_000, ttl: null }),
          result: resultOf(makeTokens(2_000, 48_000, 0), 'custom-unpriced-model'),
        },
        // Turn 2: unexplained drop on unpriced model -> null reason, null extraCostUsd
        {
          during: (t) => emitRequest(t, { used: 50_000, ttl: null }),
          result: resultOf(makeTokens(45_000, 5_000, 0), 'custom-unpriced-model'),
        },
        // Turn 3: warm again with explicit 5m TTL
        {
          during: (t) => emitRequest(t, { used: 50_000, ttl: 5 * MINUTE }),
          result: resultOf(makeTokens(2_000, 48_000, 0), 'custom-unpriced-model'),
        },
        // Turn 4: compaction completes during turn -> verifiable `compacted` reason
        {
          during: (t) => {
            t.apply({
              patches: [
                {
                  op: 'entry.add',
                  entry: {
                    kind: 'compaction',
                    id: 'cmp-1',
                    status: 'completed',
                    summary: 'Summarized earlier context.',
                  },
                },
              ],
              effects: [],
            })
            emitRequest(t, { used: 25_000, ttl: 5 * MINUTE })
          },
          result: resultOf(makeTokens(23_000, 2_000, 0), 'custom-unpriced-model'),
        },
        // Turn 5: warm again with 5m TTL
        {
          during: (t) => emitRequest(t, { used: 40_000, ttl: 5 * MINUTE }),
          result: resultOf(makeTokens(2_000, 38_000, 0), 'custom-unpriced-model'),
        },
        // Turn 6: sent within TTL (warm), but a long tool call causes request 2 to cross the 5m TTL
        {
          during: (t, step) => {
            emitRequest(t, { used: 40_000, ttl: 5 * MINUTE })
            step(6 * MINUTE)
            emitRequest(t, { used: 42_000, ttl: 5 * MINUTE })
          },
          result: resultOf(makeTokens(42_000, 40_000, 0), 'custom-unpriced-model'),
        },
      ],
    })

    expect((await send('turn 1')).cacheDrop).toBeNull()

    advance(60_000)
    const unexplained = await send('turn 2')
    expect(unexplained.cacheDrop).toMatchObject({
      baselineShare: 0.96,
      currentShare: 0.1,
      reason: null,
      extraCostUsd: null,
    })

    advance(60_000)
    expect((await send('turn 3')).cacheDrop).toBeNull()

    advance(60_000)
    const compacted = await send('turn 4')
    expect(compacted.cacheDrop).toMatchObject({
      reason: 'compacted',
      extraCostUsd: null,
    })

    advance(60_000)
    expect((await send('turn 5')).cacheDrop).toBeNull()

    advance(60_000) // Still within 5m TTL when sent!
    const midTurnExpired = await send('turn 6')
    expect(midTurnExpired.cacheDrop).toMatchObject({
      reason: 'expired',
      extraCostUsd: null,
    })
  })

  it('ignores cancelled turns and falls back to completed in-turn lastRequest when turn tokens lack cacheRead', async () => {
    const { send, advance } = await setupHarness({
      agentId: 'antigravity',
      initialModel: 'gemini-4-neon',
      turns: [
        // Turn 1: agent reports cacheRead only via lastRequest (turn.tokens is null)
        {
          during: (t) => {
            const ctx = t.context()
            emitRequest(t, { used: 40_000, ttl: null })
            t.apply({
              patches: [
                {
                  op: 'session.update',
                  changes: {
                    lastRequest: {
                      at: ctx.now,
                      input: 2_000,
                      cacheRead: 38_000,
                      cacheWrite: null,
                      output: 150,
                      ms: 900,
                    },
                  },
                },
              ],
              effects: [],
            })
          },
          result: resultOf(null),
        },
        // Turn 2: cancelled turn with 0 cacheRead must not trigger or overwrite baseline
        {
          during: (t) => emitRequest(t, { used: 40_000, ttl: null }),
          result: resultOf(makeTokens(40_000, 0, 0), 'gemini-4-neon', 'cancelled'),
        },
        // Turn 3: real drop reported via lastRequest compared against Turn 1 baseline
        {
          during: (t) => {
            const ctx = t.context()
            emitRequest(t, { used: 42_000, ttl: null })
            t.apply({
              patches: [
                {
                  op: 'session.update',
                  changes: {
                    lastRequest: {
                      at: ctx.now,
                      input: 38_000,
                      cacheRead: 4_000,
                      cacheWrite: null,
                      output: 180,
                      ms: 1200,
                    },
                  },
                },
              ],
              effects: [],
            })
          },
          result: resultOf(null),
        },
      ],
    })

    expect((await send('turn 1')).cacheDrop).toBeNull()
    advance(30_000)
    expect((await send('turn 2')).cacheDrop).toBeNull()
    advance(30_000)
    const dropped = await send('turn 3')
    expect(dropped.cacheDrop).toMatchObject({
      baselineShare: 0.95,
      currentCacheRead: 4_000,
      currentTotalInput: 42_000,
      reason: null,
    })
  })
})
