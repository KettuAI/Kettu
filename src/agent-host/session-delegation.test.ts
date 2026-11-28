import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatus } from '@shared/agent-host'
import type { ConfigOption, StopReason, ThreadEntry } from '@shared/thread'
import type { AgentManager } from './agents'
import type { SessionOptions } from './connection'
import { Diagnostics } from './diagnostics'
import type { Projects } from './projects'
import type { ScratchFolders } from './scratch'
import { SessionManager, type SessionEvents } from './sessions'
import { returnedFile, sessionsFile } from './storage'
import { startTestHost, type TestHost } from './testing/harness'
import { ThreadDb } from './threads/db'
import type { ThreadStore } from './threads/store'

vi.setConfig({ testTimeout: 60_000 })

const hosts: TestHost[] = []
const managers: SessionManager[] = []
const tempDirs: string[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
  for (const sessions of managers.splice(0)) {
    sessions.shutdown()
    await sessions.flush()
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

const isReport = (entry: ThreadEntry): entry is Extract<ThreadEntry, { kind: 'user' }> =>
  entry.kind === 'user' && entry.from?.ended !== undefined

describe('manual agent delegation over host RPC', () => {
  it('lists delegatable agents, spawns a child session directly, and reports both completion and failure back to the parent', async () => {
    const host = await startTestHost()
    hosts.push(host)
    const window = host.connect()

    const { id: parentId } = await window.request('sessions.create', {
      agentId: 'fake-agent',
      projectPath: host.project,
    })
    await window.open(parentId)
    await window.untilStatus(parentId, 'ready')

    // 1. Lists available delegation targets for the top-level parent session.
    const listed = await window.request('sessions.delegateAgents', { sessionId: parentId })
    expect(listed.canDelegate).toBe(true)
    expect(
      listed.agents.some((a) => a.id === 'fake-agent' && a.isCurrent && a.status === 'ready'),
    ).toBe(true)

    // 2. Delegate a normal task directly via `sessions.delegate`.
    const child = await window.request('sessions.delegate', {
      sessionId: parentId,
      agentId: 'fake-agent',
      content: [{ type: 'text', text: 'Check the login flow.' }],
    })
    expect(child.parentId).toBe(parentId)
    expect(child.origin).toBe('user')
    expect(child.agentId).toBe('fake-agent')

    // Parent thread immediately gets a `session_started` entry pointing at the child.
    await window.untilEntry(
      parentId,
      (entry) => entry.kind === 'session_started' && entry.sessionId === child.id,
    )

    // Child completes its turn and reports back to the parent session.
    await window.until(() =>
      window
        .entries(parentId)
        .some((entry) => isReport(entry) && entry.from?.sessionId === child.id),
    )
    const completion = window
      .entries(parentId)
      .find(
        (entry): entry is Extract<ThreadEntry, { kind: 'user' }> =>
          isReport(entry) && entry.from?.sessionId === child.id,
      )
    expect(completion?.from?.ended?.stopReason).toBe('end_turn')
    expect(completion?.from?.ended?.round).toBe(1)
    await window.untilStatus(parentId, 'ready')

    // 3. Rejects nested delegation from a child session in both list & start RPCs.
    const childListed = await window.request('sessions.delegateAgents', { sessionId: child.id })
    expect(childListed).toEqual({
      canDelegate: false,
      reason: 'nested_session',
      agents: [],
    })
    await expect(
      window.request('sessions.delegate', {
        sessionId: child.id,
        agentId: 'fake-agent',
        content: [{ type: 'text', text: 'Nested task' }],
      }),
    ).rejects.toMatchObject({ code: 'restricted' })

    // 4. Delegated child session whose turn fails reports failure back to the parent.
    const failingChild = await window.request('sessions.delegate', {
      sessionId: parentId,
      agentId: 'fake-agent',
      content: [{ type: 'text', text: '/error' }],
    })
    expect(failingChild.parentId).toBe(parentId)

    await window.until(() =>
      window
        .entries(parentId)
        .some((entry) => isReport(entry) && entry.from?.sessionId === failingChild.id),
    )
    const failureReport = window
      .entries(parentId)
      .find(
        (entry): entry is Extract<ThreadEntry, { kind: 'user' }> =>
          isReport(entry) && entry.from?.sessionId === failingChild.id,
      )
    expect(failureReport?.from?.ended?.stopReason).toBeNull()
    expect(failureReport?.from?.ended?.round).toBe(1)
    const failureText = failureReport!.content
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('')
    expect(failureText).toContain('failed')
    await window.untilStatus(parentId, 'ready')

    // 5. Rejects empty/whitespace task and archived sessions.
    await expect(
      window.request('sessions.delegate', {
        sessionId: parentId,
        agentId: 'fake-agent',
        content: [{ type: 'text', text: '   ' }],
      }),
    ).rejects.toMatchObject({ code: 'invalid_params' })

    await window.request('sessions.archive', { sessionId: parentId })
    const archivedList = await window.request('sessions.delegateAgents', { sessionId: parentId })
    expect(archivedList).toEqual({
      canDelegate: false,
      reason: 'archived',
      agents: [],
    })
    await expect(
      window.request('sessions.delegate', {
        sessionId: parentId,
        agentId: 'fake-agent',
        content: [{ type: 'text', text: 'After archive' }],
      }),
    ).rejects.toMatchObject({ code: 'restricted' })
  })

  it('resets paused report counters when the user manually delegates a new task', async () => {
    const host = await startTestHost({ startedSessions: { working: 3, daily: 10, reports: 1 } })
    hosts.push(host)
    const window = host.connect()

    const { id: parentId } = await window.request('sessions.create', {
      agentId: 'fake-agent',
      projectPath: host.project,
    })
    await window.open(parentId)
    await window.untilStatus(parentId, 'ready')

    // First report consumes the reports=1 budget; second tool-started session triggers reports_paused.
    await host.host.sessions.startFromTool(parentId, {
      prompt: 'First.',
      options: {},
      report: true,
    })
    await window.until(() => window.entries(parentId).filter(isReport).length === 1)
    await window.untilStatus(parentId, 'ready')

    await host.host.sessions.startFromTool(parentId, {
      prompt: 'Second.',
      options: {},
      report: true,
    })
    await window.untilEntry(
      parentId,
      (entry) => entry.kind === 'notice' && entry.cause === 'reports_paused',
    )

    // Manual delegation resets the counter so its result arrives in the parent session.
    const manualChild = await window.request('sessions.delegate', {
      sessionId: parentId,
      agentId: 'fake-agent',
      content: [{ type: 'text', text: 'Manual task after pause' }],
    })
    await window.until(() =>
      window
        .entries(parentId)
        .some((entry) => isReport(entry) && entry.from?.sessionId === manualChild.id),
    )
  })
})

describe('manual delegation #2727 permission inheritance and safety boundaries', () => {
  type Harness = 'claude-code' | 'codex' | 'antigravity' | 'deepseek' | 'opencode'

  const CHOICES: Record<Harness, string[]> = {
    'claude-code': ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'],
    codex: ['read-only', 'workspace-write', 'agent', 'agent-full-access'],
    antigravity: ['default', 'accept-edits', 'auto', 'plan', 'dangerously-skip-permissions'],
    deepseek: ['plan', 'read-only', 'workspace-write', 'danger-full-access'],
    opencode: [],
  }
  const INITIAL: Record<Harness, string | null> = {
    'claude-code': 'default',
    codex: 'read-only',
    antigravity: 'default',
    deepseek: 'workspace-write',
    opencode: null,
  }

  function modeOption(value: string, choices: string[]): ConfigOption {
    return {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      value,
      choices: choices.map((c) => ({ value: c, name: c })),
    }
  }

  function makeStatus(id: Harness, overrides: Partial<AgentStatus> = {}): AgentStatus {
    return {
      id,
      name: id,
      harnessId: id,
      harnessName: id,
      isDefault: true,
      registered: true,
      hidden: false,
      disabled: false,
      apiKey: null,
      state: 'ready',
      version: '1.0.0',
      package: null,
      signIn: 'signed-in',
      authMethods: [],
      canLogout: false,
      account: null,
      limits: [],
      detail: null,
      installUrl: null,
      progress: [],
      launchCommand: '',
      binaryOverride: null,
      binaryCommand: null,
      update: null,
      updateCheckedAt: null,
      updateSkipped: false,
      task: null,
      installMethods: [],
      cli: null,
      configDir: null,
      kettuServer: { runs: true, active: true },
      capabilities: {
        loadSession: true,
        listSessions: true,
        resumeSession: true,
        closeSession: false,
        deleteSession: false,
        forkSession: false,
        forkAtMessage: false,
        steering: false,
        reports: false,
        context: false,
        liveContext: false,
        account: false,
        mcpHttp: true,
        prompt: { image: false, audio: false, embeddedContext: false },
      },
      ...overrides,
    }
  }

  async function setupCrossHarness() {
    const dir = await mkdtemp(path.join(tmpdir(), 'kettu-delegate-2727-'))
    tempDirs.push(dir)
    const db = ThreadDb.open(path.join(dir, 'threads.db'), () => {})
    const threads = {
      load: async (id: string) => db.load(id),
      write: async (id: string, change: Parameters<ThreadDb['write']>[1]) => {
        db.write(id, change)
      },
      remove: async (ids: readonly string[]) => {
        db.remove(ids)
      },
      putOrigin: async () => {},
      origins: async () => [],
    } as unknown as ThreadStore

    const newCalls: { agentId: Harness; fullAccess?: boolean }[] = []
    const configs = new Map<string, ConfigOption[]>()
    let nextId = 0

    const makeRuntime = (agentId: Harness) => {
      const connection = {
        isClosed: false,
        closed: new Promise<void>(() => {}),
        close: () => {},
        register: () => {},
        unregister: () => {},
        reopen: () => {},
        offersFullAccess: () => agentId !== 'opencode',
        newSession: vi.fn(async (_cwd: string, options?: SessionOptions) => {
          const acpId = `${agentId}-${++nextId}`
          newCalls.push({ agentId, fullAccess: options?.fullAccess })
          const initial =
            agentId === 'antigravity' && options?.fullAccess
              ? 'dangerously-skip-permissions'
              : INITIAL[agentId]
          const config = initial === null ? [] : [modeOption(initial, CHOICES[agentId])]
          configs.set(acpId, config)
          return { sessionId: acpId, config }
        }),
        setConfigOption: vi.fn(async (acpId: string, optionId: string, value: string | boolean) => {
          const current = configs.get(acpId) ?? []
          const next = current.map((opt) => (opt.id === optionId ? { ...opt, value } : opt))
          configs.set(acpId, next)
          return next
        }),
        loadSession: async () => ({ config: [] }),
        resumeSession: async (acpId: string) => ({ config: configs.get(acpId) ?? [] }),
        listSessions: async () => ({ sessions: [], nextCursor: null }),
        cancel: async () => {},
        prompt: vi.fn(async () => ({
          stopReason: 'end_turn' as StopReason,
          tokens: null,
          models: [],
        })),
      }
      return {
        agentId,
        kettu: false,
        init: {
          name: agentId,
          version: '1.0.0',
          capabilities: {
            loadSession: true,
            listSessions: true,
            resumeSession: true,
            closeSession: false,
            deleteSession: false,
            forkSession: false,
            forkAtMessage: false,
            ownTitles: null,
            logout: false,
            steering: false,
            mcpHttp: true,
            mcpSse: false,
            mcpStdio: true,
            prompt: { image: false, audio: false, embeddedContext: false },
          },
          authMethods: [],
          raw: null,
        },
        connection,
      }
    }

    const runtimes: Record<Harness, ReturnType<typeof makeRuntime>> = {
      'claude-code': makeRuntime('claude-code'),
      codex: makeRuntime('codex'),
      antigravity: makeRuntime('antigravity'),
      deepseek: makeRuntime('deepseek'),
      opencode: makeRuntime('opencode'),
    }

    const agents = {
      has: (id: string) => id in runtimes,
      name: (id: Harness) => id,
      assertEnabled: () => {},
      isDisabled: () => false,
      runningConfig: () => null,
      sessionsChanged: () => {},
      restoreConfig: (_agentId: string, config: unknown[]) => config,
      signedIn: () => {},
      authRequired: () => {},
      offersFullAccess: (id: Harness) => id !== 'opencode',
      status: (id: Harness) => ({ capabilities: runtimes[id].init.capabilities, limits: [] }),
      whileOpening: (_agentId: string, start: Promise<unknown>) => start,
      hasContext: () => false,
      refreshLimits: async () => {},
      runtime: (id: Harness) => runtimes[id],
      ensureReady: async (id: Harness) => runtimes[id],
    } as unknown as AgentManager

    const sessions = new SessionManager({
      platform: 'darwin',
      hostId: 'host-a',
      agents,
      projects: {
        list: () => [],
        resolveDirectory: async (folder: string) => folder,
        add: async () => {},
      } as unknown as Projects,
      scratch: { contains: () => false } as unknown as ScratchFolders,
      file: sessionsFile(dir, () => {}),
      returned: returnedFile(dir, () => {}),
      portOpen: () => false,
      threads,
      reportsDir: path.join(dir, 'reports'),
      diagnostics: new Diagnostics(),
      git: () => null,
      events: new Proxy({}, { get: () => () => {} }) as SessionEvents,
      settings: () =>
        ({
          startModes: { 'claude-code': 'default', codex: 'read-only' },
          startedSessions: { working: 3, daily: 10, reports: 10 },
        }) as never,
      timings: { flushMs: 0, checkpointMs: 10 },
    })
    managers.push(sessions)
    await sessions.load()
    return { sessions, db, newCalls, runtimes }
  }

  it('enforces #2727 inheritance (Full access, lower cap, cross-harness mapping, unavailable rejection) and works on persisted closed parents', async () => {
    const { sessions, db, newCalls, runtimes } = await setupCrossHarness()
    try {
      const statuses: AgentStatus[] = [
        makeStatus('claude-code'),
        makeStatus('codex'),
        makeStatus('antigravity'),
        makeStatus('deepseek'),
        makeStatus('opencode'),
      ]

      const parent = await sessions.create({ agentId: 'claude-code', projectPath: '/repo' })
      await sessions.setConfigOption(parent.id, 'mode', 'bypassPermissions')

      // 1. delegateAgents reflects Full access inheritance across all ranked harnesses,
      // and excludes disabled/hidden/not-installed agents.
      const listedFull = await sessions.delegateAgents(parent.id, [
        ...statuses,
        makeStatus('codex', { id: 'codex~off' as AgentStatus['id'], disabled: true }),
        makeStatus('deepseek', {
          id: 'deepseek~missing' as AgentStatus['id'],
          state: 'not-installed',
        }),
      ])
      expect(listedFull.canDelegate).toBe(true)
      expect(listedFull.agents.map((a) => a.id)).toEqual([
        'claude-code',
        'codex',
        'antigravity',
        'deepseek',
        'opencode',
      ])
      expect(listedFull.agents.find((a) => a.id === 'claude-code')?.inheritedMode?.id).toBe(
        'bypassPermissions',
      )
      expect(listedFull.agents.find((a) => a.id === 'codex')?.inheritedMode?.id).toBe(
        'agent-full-access',
      )
      expect(listedFull.agents.find((a) => a.id === 'antigravity')?.inheritedMode?.id).toBe(
        'dangerously-skip-permissions',
      )
      expect(listedFull.agents.find((a) => a.id === 'deepseek')?.inheritedMode?.id).toBe(
        'danger-full-access',
      )
      expect(listedFull.agents.find((a) => a.id === 'opencode')?.inheritedMode).toBeNull()

      // 2. Delegating inherits Full access across harnesses without extra prompts or holds.
      const codexChild = await sessions.delegate(
        {
          sessionId: parent.id,
          agentId: 'codex',
          content: [{ type: 'text', text: 'Refactor module' }],
        },
        statuses,
      )
      expect((await sessions.toolMode(codexChild.id))?.id).toBe('agent-full-access')
      expect(sessions.firstHeld(codexChild.id)).toBe(false)

      const agyChild = await sessions.delegate(
        {
          sessionId: parent.id,
          agentId: 'antigravity',
          content: [{ type: 'text', text: 'Run checks' }],
        },
        statuses,
      )
      expect((await sessions.toolMode(agyChild.id))?.id).toBe('dangerously-skip-permissions')
      expect(newCalls.find((c) => c.agentId === 'antigravity')?.fullAccess).toBe(true)

      const opencodeChild = await sessions.delegate(
        {
          sessionId: parent.id,
          agentId: 'opencode',
          content: [{ type: 'text', text: 'Summarize diff' }],
        },
        statuses,
      )
      expect(await sessions.toolMode(opencodeChild.id)).toBeNull()

      // 3. Explicit narrower mode is honored under Full access.
      const narrowCodex = await sessions.delegate(
        {
          sessionId: parent.id,
          agentId: 'codex',
          mode: 'read-only',
          content: [{ type: 'text', text: 'Read only audit' }],
        },
        statuses,
      )
      expect((await sessions.toolMode(narrowCodex.id))?.id).toBe('read-only')

      // 4. Lower parent mode (acceptEdits, rank 2) caps delegated children and prevents escalation.
      await sessions.setConfigOption(parent.id, 'mode', 'acceptEdits')
      const listedRank2 = await sessions.delegateAgents(parent.id, statuses)
      const codexRank2 = listedRank2.agents.find((a) => a.id === 'codex')!
      expect(codexRank2.inheritedMode?.id).toBe('workspace-write')
      expect(codexRank2.modes.map((m) => m.id)).toEqual(['read-only', 'workspace-write'])

      const cappedChild = await sessions.delegate(
        {
          sessionId: parent.id,
          agentId: 'codex',
          mode: 'agent-full-access',
          content: [{ type: 'text', text: 'Attempt wider permissions' }],
        },
        statuses,
      )
      expect((await sessions.toolMode(cappedChild.id))?.id).toBe('workspace-write')

      // 5. Rejects unavailable / disabled / not-installed / installing target agents.
      await expect(
        sessions.delegate(
          {
            sessionId: parent.id,
            agentId: 'codex',
            content: [{ type: 'text', text: 'Blocked' }],
          },
          [makeStatus('codex', { disabled: true })],
        ),
      ).rejects.toMatchObject({ code: 'invalid_params' })
      await expect(
        sessions.delegate(
          {
            sessionId: parent.id,
            agentId: 'codex',
            content: [{ type: 'text', text: 'Blocked' }],
          },
          [makeStatus('codex', { state: 'not-installed' })],
        ),
      ).rejects.toMatchObject({ code: 'restricted' })
      await expect(
        sessions.delegate(
          {
            sessionId: parent.id,
            agentId: 'codex',
            content: [{ type: 'text', text: 'Blocked' }],
          },
          [makeStatus('codex', { state: 'installing' })],
        ),
      ).rejects.toMatchObject({ code: 'busy' })

      // 6. Persisted closed parent session retains its effective permission mode when delegating.
      await sessions.setConfigOption(parent.id, 'mode', 'bypassPermissions')
      await sessions.close(parent.id)
      const parentPromptsBefore = runtimes['claude-code'].connection.prompt.mock.calls.length
      const closedList = await sessions.delegateAgents(parent.id, statuses)
      expect(closedList.agents.find((a) => a.id === 'deepseek')?.inheritedMode?.id).toBe(
        'danger-full-access',
      )
      const childFromClosed = await sessions.delegate(
        {
          sessionId: parent.id,
          agentId: 'deepseek',
          content: [{ type: 'text', text: 'Delegate from closed parent' }],
        },
        statuses,
      )
      expect((await sessions.toolMode(childFromClosed.id))?.id).toBe('danger-full-access')
      // Parent session's own agent was never invoked to process the delegated task.
      expect(runtimes['claude-code'].connection.prompt.mock.calls.length).toBe(parentPromptsBefore)
    } finally {
      db.close()
    }
  })
})
