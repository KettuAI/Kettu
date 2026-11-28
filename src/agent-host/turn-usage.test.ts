import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentAccount } from '@shared/agent-host'
import type { ConfigOption, ThreadEntry, TurnUsage } from '@shared/thread'
import type { AgentManager } from './agents'
import type { PromptResult, SessionTarget } from './connection'
import { Diagnostics } from './diagnostics'
import type { Projects } from './projects'
import type { ScratchFolders } from './scratch'
import { SessionManager, type SessionEvents } from './sessions'
import { returnedFile, sessionsFile } from './storage'
import type { StoredThread, ThreadPage } from './threads/model'
import type { ThreadStore } from './threads/store'
import { PRICES, type UsageRow } from './usage/model'

let dir: string
const managers: SessionManager[] = []

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'kettu-turn-usage-'))
})

afterEach(async () => {
  const created = managers.splice(0)
  for (const sessions of created) sessions.shutdown()
  await Promise.all(created.map((sessions) => sessions.flush()))
  await rm(dir, { recursive: true, force: true })
})

const log = () => {}

function modelConfig(value: string): ConfigOption[] {
  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      value,
      choices: [
        { value: 'sonnet', name: 'Sonnet', modelId: 'claude-sonnet-4-6' },
        { value: 'custom', name: 'Custom', modelId: 'custom-unpriced-model' },
      ],
    },
  ]
}

async function setupSession(options: {
  agentId?: 'claude-code' | 'codex'
  account?: AgentAccount | null
  initialModel?: string
  turns?: PromptResult[]
  storedThread?: StoredThread | null
  storedPage?: ThreadPage | null
  sessionTurnUsage?: (sessionId: string) => Promise<Record<string, TurnUsage>>
}) {
  const repo = path.join(dir, 'repo')
  await mkdir(repo, { recursive: true })
  let clock = 1_700_000_000_000
  const config = modelConfig(options.initialModel ?? 'sonnet')
  const targets = new Map<string, SessionTarget>()
  const queue = [...(options.turns ?? [])]
  const recorded: UsageRow[] = []

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
    setConfigOption: async () => config,
    prompt: async (): Promise<PromptResult> => {
      clock += 2500
      const next = queue.shift()
      if (!next) throw new Error('Unexpected prompt call')
      return next
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

  const threadStore =
    options.storedThread !== undefined || options.storedPage !== undefined
      ? ({
          load: async () => options.storedThread ?? null,
          page: async () => options.storedPage ?? null,
          tail: async () => options.storedPage ?? null,
          write: async () => {},
          delete: async () => {},
        } as unknown as ThreadStore)
      : null

  const sessionTurnUsage = vi.fn(options.sessionTurnUsage ?? (async () => ({})))

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
    threads: threadStore,
    reportsDir: path.join(dir, 'reports'),
    diagnostics: new Diagnostics(),
    git: () => null,
    usage: {
      record: (rows) => recorded.push(...rows),
      syncAgents: async () => {},
      sessionTurnUsage,
    },
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

  return { sessions, repo, recorded, sessionTurnUsage }
}

describe('SessionManager turn_end usage persistence and legacy hydration', () => {
  it('attaches per-model TurnUsage with subscription flag to turn_end on completed live turns', async () => {
    const priced = Object.keys(PRICES.models).find((m) => PRICES.models[m]!.input > 0)!
    const { sessions, repo, recorded } = await setupSession({
      agentId: 'claude-code',
      account: { kind: 'account', label: 'Claude Max', email: 'dev@example.com' },
      turns: [
        {
          stopReason: 'end_turn',
          tokens: null,
          models: [
            {
              model: priced,
              tokens: {
                total: 10_500,
                input: 1000,
                output: 500,
                thought: null,
                cacheRead: 8000,
                cacheWrite: 1000,
              },
            },
          ],
        },
      ],
    })

    const created = await sessions.create({ agentId: 'claude-code', projectPath: repo })
    await sessions.prompt(created.id, [{ type: 'text', text: 'Summarize the changes.' }])
    for (let i = 0; i < 50; i++) {
      if ((await sessions.snapshot(created.id)).session.status === 'ready') break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    const snap = await sessions.snapshot(created.id)
    const end = snap.entries.find(
      (entry): entry is Extract<ThreadEntry, { kind: 'turn_end' }> => entry.kind === 'turn_end',
    )
    expect(end).toBeDefined()
    expect(end!.usage).toBeDefined()
    expect(end!.usage!.subscription).toBe(true)
    expect(end!.usage!.costUsd).toBeGreaterThan(0)
    expect(end!.usage!.models).toHaveLength(1)
    expect(end!.usage!.models[0]).toMatchObject({
      model: priced,
      input: 1000,
      output: 500,
      cacheRead: 8000,
      cacheWrite: 1000,
    })
    expect(recorded.length).toBe(1)
    expect(recorded[0]!.key).toBe(`ob:${created.id}:${end!.id}:${priced}`)
  })

  it('resolves choice modelId when an agent reports only turn tokens without per-model map', async () => {
    const { sessions, repo } = await setupSession({
      agentId: 'claude-code',
      account: { kind: 'api_key', label: 'Anthropic API key', email: null },
      initialModel: 'sonnet',
      turns: [
        {
          stopReason: 'end_turn',
          tokens: {
            total: 3500,
            input: 1000,
            output: 500,
            thought: null,
            cacheRead: 2000,
            cacheWrite: 0,
          },
          models: [],
        },
      ],
    })

    const created = await sessions.create({ agentId: 'claude-code', projectPath: repo })
    await sessions.prompt(created.id, [{ type: 'text', text: 'Hi' }])
    for (let i = 0; i < 50; i++) {
      if ((await sessions.snapshot(created.id)).session.status === 'ready') break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    const snap = await sessions.snapshot(created.id)
    const end = snap.entries.find(
      (entry): entry is Extract<ThreadEntry, { kind: 'turn_end' }> => entry.kind === 'turn_end',
    )
    expect(end?.usage?.subscription).toBe(false)
    expect(end?.usage?.models[0]?.model).toBe('claude-sonnet-4-6')
    expect(end?.usage?.costUsd).toBeGreaterThan(0)
  })

  it('hydrates legacy stored turn_end entries once via usage.sessionTurnUsage and skips I/O when usage is already present', async () => {
    const hydratedUsage: TurnUsage = {
      models: [
        {
          model: 'claude-sonnet-4-6',
          input: 1200,
          output: 300,
          cacheRead: 4000,
          cacheWrite: 500,
          costUsd: 0.014,
        },
      ],
      costUsd: 0.014,
    }
    const storedPage: ThreadPage = {
      head: { agentId: 'claude-code', acpSessionId: 'acp-legacy' },
      session: {
        title: 'Legacy',
        config: [],
        commands: [],
        usage: null,
        subagent: null,
        context: null,
        sideChat: null,
      },
      entries: [
        { kind: 'user', id: 'e:1', content: [{ type: 'text', text: 'Old prompt' }], at: 100 },
        {
          kind: 'agent',
          id: 'e:2',
          markdown: 'Old answer',
          attachments: [],
          streaming: false,
          at: 200,
        },
        { kind: 'turn_end', id: 'e:3', stopReason: 'end_turn', durationMs: 4000 },
      ],
      from: 0,
      older: null,
      plan: null,
    }

    // Seed a stored session record on disk so snapshot reads from storedPage rather than live memory.
    const repo = path.join(dir, 'repo')
    await mkdir(repo, { recursive: true })
    const file = sessionsFile(dir, log)
    file.save({
      version: 1,
      sessions: [
        {
          id: 'legacy-session',
          agentId: 'claude-code',
          acpSessionId: 'acp-legacy',
          projectPath: repo,
          title: 'Legacy',
          createdAt: 100,
          updatedAt: 200,
          lastViewedAt: 200,
          parentId: null,
          origin: 'user',
          description: null,
          branch: null,
        },
      ],
    })
    await file.flush()

    const { sessions, sessionTurnUsage } = await setupSession({
      storedPage,
      sessionTurnUsage: async () => ({ 'e:3': hydratedUsage }),
    })

    const snap = await sessions.snapshot('legacy-session')
    expect(sessionTurnUsage).toHaveBeenCalledTimes(1)
    expect(sessionTurnUsage).toHaveBeenCalledWith('legacy-session')
    const end = snap.entries.find(
      (entry): entry is Extract<ThreadEntry, { kind: 'turn_end' }> => entry.kind === 'turn_end',
    )
    expect(end?.usage).toEqual(hydratedUsage)

    // When entries already carry `usage`, no usage DB query should be issued.
    sessionTurnUsage.mockClear()
    storedPage.entries[2] = {
      kind: 'turn_end',
      id: 'e:3',
      stopReason: 'end_turn',
      durationMs: 4000,
      usage: hydratedUsage,
    }
    await sessions.snapshot('legacy-session')
    expect(sessionTurnUsage).not.toHaveBeenCalled()
  })
})
