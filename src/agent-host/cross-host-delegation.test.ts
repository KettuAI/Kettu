import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostMethod, HostParams, HostResult, SessionSummary } from '@shared/agent-host'
import type { RemoteDelegationEntry, ThreadEntry } from '@shared/thread'
import { startTestHost, type TestHost } from './testing/harness'
import { SESSION_TOOLS } from './session-tools'
import {
  createCrossHostDelegationTracker,
  type ActiveCrossHostDelegation,
} from '@shared/cross-host-delegation'

vi.setConfig({ testTimeout: 60_000 })

const hosts: TestHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
})

const isRemoteDelegation = (entry: ThreadEntry): entry is RemoteDelegationEntry =>
  entry.kind === 'remote_delegation'

describe('manual cross-host delegation (#2581)', () => {
  it('creates a normal visible session on the target host without inheriting origin permissions and reports completion & failure back', async () => {
    const originHost = await startTestHost()
    const targetHost = await startTestHost()
    hosts.push(originHost, targetHost)

    const originWindow = originHost.connect()
    const targetWindow = targetHost.connect()

    // Create an origin session on host A.
    const originSession = await originWindow.request('sessions.create', {
      agentId: 'fake-agent',
      projectPath: originHost.project,
    })
    await originWindow.open(originSession.id)
    await originWindow.untilStatus(originSession.id, 'ready')

    const TARGET_HOST_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const summaries = new Map<string, SessionSummary>()
    const learnedHosts = new Map<string, string>()
    const createCalls: HostParams<'sessions.create'>[] = []
    let stored: ActiveCrossHostDelegation[] = []
    let idCounter = 0

    const tracker = createCrossHostDelegationTracker({
      requestAt: async <M extends HostMethod>(
        hostId: string | null,
        method: M,
        params: HostParams<M>,
      ): Promise<HostResult<M>> => {
        if (hostId === TARGET_HOST_ID) {
          if (method === 'sessions.create') {
            createCalls.push(params as HostParams<'sessions.create'>)
          }
          return targetWindow.request(method, params)
        }
        return originWindow.request(method, params)
      },
      getSessionSummary: (id) => summaries.get(id),
      upsertSession: (summary) => summaries.set(summary.id, summary),
      learnSessionHost: (hostId, sessionId) => learnedHosts.set(sessionId, hostId),
      readStored: () => stored,
      writeStored: (items) => {
        stored = items
      },
      newId: () => `rdel-${++idCounter}`,
      now: () => Date.now(),
    })

    // 1. Delegate a normal task from originHost to targetHost.
    const { delegationId, summary: targetCreated } = await tracker.delegate({
      originSessionId: originSession.id,
      originHostId: null,
      targetHostId: TARGET_HOST_ID,
      targetHostName: 'Office PC',
      targetHostPlatform: 'win32',
      targetProjectPath: targetHost.project,
      targetProjectName: 'target-project',
      targetAgentId: 'fake-agent',
      targetAgentName: 'Fake agent',
      taskText: 'Verify the build on Office PC.',
      promptText: 'Verify the build on Office PC.',
    })

    // Security boundary: target `sessions.create` must NEVER receive parentId, options, or permission mode.
    expect(createCalls).toHaveLength(1)
    expect(createCalls[0]).toEqual({
      agentId: 'fake-agent',
      projectPath: targetHost.project,
      prompt: [{ type: 'text', text: 'Verify the build on Office PC.' }],
    })
    expect('options' in createCalls[0]!).toBe(false)
    expect('parentId' in createCalls[0]!).toBe(false)

    // Target session is a normal visible top-level user session on targetHost.
    expect(targetCreated.parentId).toBeNull()
    expect(targetCreated.origin).toBe('user')
    expect(learnedHosts.get(targetCreated.id)).toBe(TARGET_HOST_ID)
    const targetList = await targetWindow.request('sessions.list', {})
    expect(targetList.some((s) => s.id === targetCreated.id && s.parentId === null)).toBe(true)

    // Origin thread records a `remote_delegation` started notice linking to the target session.
    await originWindow.untilEntry(
      originSession.id,
      (entry) =>
        isRemoteDelegation(entry) &&
        entry.delegationId === delegationId &&
        entry.phase === 'started',
    )
    const startedEntry = originWindow
      .entries(originSession.id)
      .find(
        (entry): entry is RemoteDelegationEntry =>
          isRemoteDelegation(entry) &&
          entry.delegationId === delegationId &&
          entry.phase === 'started',
      )
    expect(startedEntry).toMatchObject({
      targetHostId: TARGET_HOST_ID,
      targetHostName: 'Office PC',
      targetSessionId: targetCreated.id,
      targetProjectName: 'target-project',
      targetAgentId: 'fake-agent',
      targetAgentName: 'Fake agent',
    })

    // Wait for target session to finish its turn via session.summary (without opening it locally).
    await targetWindow.until(() => {
      const s = targetWindow.summary(targetCreated.id)
      return s !== undefined && s.status === 'ready' && s.lastTurn != null
    })
    const finishedSummary = targetWindow.summary(targetCreated.id)!
    summaries.set(finishedSummary.id, finishedSummary)
    await tracker.onSessionSummary(finishedSummary)

    // Origin session receives a completion report with excerpt and jump link.
    await originWindow.untilEntry(
      originSession.id,
      (entry) =>
        isRemoteDelegation(entry) &&
        entry.delegationId === delegationId &&
        entry.phase === 'report',
    )
    const completedReport = originWindow
      .entries(originSession.id)
      .find(
        (entry): entry is RemoteDelegationEntry =>
          isRemoteDelegation(entry) &&
          entry.delegationId === delegationId &&
          entry.phase === 'report',
      )
    expect(completedReport).toMatchObject({
      phase: 'report',
      outcome: 'completed',
      targetHostId: TARGET_HOST_ID,
      targetHostName: 'Office PC',
      targetSessionId: targetCreated.id,
    })
    expect(completedReport?.summary).toBeTruthy()
    expect(tracker.active()).toHaveLength(0)

    // 2. Delegate a failing task (`/error`) and verify failure is reported back to origin session.
    const { delegationId: failDelegationId, summary: failingCreated } = await tracker.delegate({
      originSessionId: originSession.id,
      originHostId: null,
      targetHostId: TARGET_HOST_ID,
      targetHostName: 'Office PC',
      targetHostPlatform: 'win32',
      targetProjectPath: targetHost.project,
      targetProjectName: 'target-project',
      targetAgentId: 'fake-agent',
      targetAgentName: 'Fake agent',
      taskText: '/error',
      promptText: '/error',
    })
    // Wait for the failing turn to settle via session.summary (no local open required).
    await targetWindow.until(() => {
      const s = targetWindow.summary(failingCreated.id)
      return s !== undefined && (s.attention === 'error' || s.lastTurn?.reason === 'failed')
    })
    const failedSummary = targetWindow.summary(failingCreated.id)!
    summaries.set(failedSummary.id, failedSummary)
    await tracker.onSessionSummary(failedSummary)

    await originWindow.untilEntry(
      originSession.id,
      (entry) =>
        isRemoteDelegation(entry) &&
        entry.delegationId === failDelegationId &&
        entry.phase === 'report',
    )
    const failureReport = originWindow
      .entries(originSession.id)
      .find(
        (entry): entry is RemoteDelegationEntry =>
          isRemoteDelegation(entry) &&
          entry.delegationId === failDelegationId &&
          entry.phase === 'report',
      )
    expect(failureReport).toMatchObject({
      phase: 'report',
      outcome: 'failed',
      targetSessionId: failingCreated.id,
    })
    expect(failureReport?.error).toBeTruthy()
  })

  it('is idempotent on duplicate delegation records and marks background origin sessions unread on report', async () => {
    const originHost = await startTestHost()
    hosts.push(originHost)
    const window = originHost.connect()

    const origin = await window.request('sessions.create', {
      agentId: 'fake-agent',
      projectPath: originHost.project,
    })
    await window.open(origin.id)
    await window.untilStatus(origin.id, 'ready')
    // Move focus away from the origin session so incoming report marks it unread.
    await window.request('sessions.show', { sessionIds: [] })

    const base = {
      sessionId: origin.id,
      delegationId: 'del-idempotent-1',
      targetHostId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      targetHostName: 'Build Mac',
      targetHostPlatform: 'darwin',
      targetSessionId: 'remote-sess-99',
      targetProjectPath: '/Users/dev/app',
      targetProjectName: 'app',
      targetAgentId: 'codex' as const,
      targetAgentName: 'Codex',
      targetTitle: 'Run tests',
    }

    const firstStart = await window.request('sessions.recordRemoteDelegation', {
      ...base,
      phase: 'started',
      promptPreview: 'Run full test suite',
    })
    const duplicateStart = await window.request('sessions.recordRemoteDelegation', {
      ...base,
      phase: 'started',
      promptPreview: 'Run full test suite',
    })
    expect(duplicateStart.entryId).toBe(firstStart.entryId)

    const firstReport = await window.request('sessions.recordRemoteDelegation', {
      ...base,
      phase: 'report',
      outcome: 'completed',
      summary: 'All 42 tests passed.',
    })
    const duplicateReport = await window.request('sessions.recordRemoteDelegation', {
      ...base,
      phase: 'report',
      outcome: 'completed',
      summary: 'All 42 tests passed.',
    })
    expect(duplicateReport.entryId).toBe(firstReport.entryId)

    const recorded = window.entries(origin.id).filter(isRemoteDelegation)
    expect(recorded).toHaveLength(2)
    expect(recorded[0]!.phase).toBe('started')
    expect(recorded[1]!.phase).toBe('report')

    const listed = await window.request('sessions.list', {})
    expect(listed.find((s) => s.id === origin.id)?.attention).toBe('unread')
  })

  it('reports failure when the remote session is deleted or host pairing is removed, and reconciles on reconnect', async () => {
    const originHost = await startTestHost()
    const targetHost = await startTestHost()
    hosts.push(originHost, targetHost)

    const originWindow = originHost.connect()
    const targetWindow = targetHost.connect()

    const origin = await originWindow.request('sessions.create', {
      agentId: 'fake-agent',
      projectPath: originHost.project,
    })
    await originWindow.open(origin.id)
    await originWindow.untilStatus(origin.id, 'ready')

    const TARGET_HOST_ID = 'cccccccccccccccccccccccccccccccc'
    const summaries = new Map<string, SessionSummary>()
    let stored: ActiveCrossHostDelegation[] = []
    let counter = 0

    const makeTracker = () =>
      createCrossHostDelegationTracker({
        requestAt: <M extends HostMethod>(
          hostId: string | null,
          method: M,
          params: HostParams<M>,
        ) =>
          hostId === TARGET_HOST_ID
            ? targetWindow.request(method, params)
            : originWindow.request(method, params),
        getSessionSummary: (id) => summaries.get(id),
        upsertSession: (summary) => summaries.set(summary.id, summary),
        learnSessionHost: () => {},
        readStored: () => stored,
        writeStored: (items) => {
          stored = items
        },
        newId: () => `rdel-edge-${++counter}`,
        now: () => Date.now(),
      })

    const tracker = makeTracker()

    // Case A: Remote session removed before completion.
    const { delegationId: removedId, summary: removedTarget } = await tracker.delegate({
      originSessionId: origin.id,
      originHostId: null,
      targetHostId: TARGET_HOST_ID,
      targetHostName: 'Linux Box',
      targetProjectPath: targetHost.project,
      targetProjectName: 'proj',
      targetAgentId: 'fake-agent',
      targetAgentName: 'Fake agent',
      taskText: 'Long task',
      promptText: 'Long task',
    })
    await tracker.onSessionRemoved(removedTarget.id)

    await originWindow.untilEntry(
      origin.id,
      (entry) =>
        isRemoteDelegation(entry) && entry.delegationId === removedId && entry.phase === 'report',
    )
    const removedReport = originWindow
      .entries(origin.id)
      .find(
        (entry): entry is RemoteDelegationEntry =>
          isRemoteDelegation(entry) && entry.delegationId === removedId && entry.phase === 'report',
      )
    expect(removedReport?.outcome).toBe('failed')

    // Case B: Target host finishes while disconnected, then reconnects and a hydrated tracker reconciles.
    const { delegationId: reconnectId, summary: reconnectTarget } = await tracker.delegate({
      originSessionId: origin.id,
      originHostId: null,
      targetHostId: TARGET_HOST_ID,
      targetHostName: 'Linux Box',
      targetProjectPath: targetHost.project,
      targetProjectName: 'proj',
      targetAgentId: 'fake-agent',
      targetAgentName: 'Fake agent',
      taskText: 'Finish while offline',
      promptText: 'Finish while offline',
    })
    await targetWindow.until(() => {
      const s = targetWindow.summary(reconnectTarget.id)
      return s !== undefined && s.status === 'ready' && s.lastTurn != null
    })
    const synced = targetWindow.summary(reconnectTarget.id)!
    summaries.set(synced.id, synced)

    const rehydrated = makeTracker()
    rehydrated.hydrate()
    await rehydrated.onHostOpened(TARGET_HOST_ID)

    await originWindow.untilEntry(
      origin.id,
      (entry) =>
        isRemoteDelegation(entry) && entry.delegationId === reconnectId && entry.phase === 'report',
    )
    const reconnectReport = originWindow
      .entries(origin.id)
      .find(
        (entry): entry is RemoteDelegationEntry =>
          isRemoteDelegation(entry) &&
          entry.delegationId === reconnectId &&
          entry.phase === 'report',
      )
    expect(reconnectReport?.outcome).toBe('completed')

    // Case C: Pairing removed before a delegated task completes.
    const { delegationId: goneId } = await rehydrated.delegate({
      originSessionId: origin.id,
      originHostId: null,
      targetHostId: TARGET_HOST_ID,
      targetHostName: 'Linux Box',
      targetProjectPath: targetHost.project,
      targetProjectName: 'proj',
      targetAgentId: 'fake-agent',
      targetAgentName: 'Fake agent',
      taskText: 'Task before unpair',
      promptText: 'Task before unpair',
    })
    await rehydrated.onHostGone(TARGET_HOST_ID)

    await originWindow.untilEntry(
      origin.id,
      (entry) =>
        isRemoteDelegation(entry) && entry.delegationId === goneId && entry.phase === 'report',
    )
    const goneReport = originWindow
      .entries(origin.id)
      .find(
        (entry): entry is RemoteDelegationEntry =>
          isRemoteDelegation(entry) && entry.delegationId === goneId && entry.phase === 'report',
      )
    expect(goneReport?.outcome).toBe('failed')
    expect(goneReport?.error).toContain('Linux Box')
  })

  it('never passes or inherits origin Full access mode onto the target host', async () => {
    const originHost = await startTestHost()
    const targetHost = await startTestHost()
    hosts.push(originHost, targetHost)

    const originWindow = originHost.connect()
    const targetWindow = targetHost.connect()

    // Origin session is explicitly elevated to Full access on originHost.
    const origin = await originWindow.request('sessions.create', {
      agentId: 'fake-agent',
      projectPath: originHost.project,
      options: { mode: 'bypassPermissions' },
    })
    await originWindow.open(origin.id)
    await originWindow.untilStatus(origin.id, 'ready')

    const TARGET_HOST_ID = 'dddddddddddddddddddddddddddddddd'
    const sentCreateParams: HostParams<'sessions.create'>[] = []
    const tracker = createCrossHostDelegationTracker({
      requestAt: async <M extends HostMethod>(
        hostId: string | null,
        method: M,
        params: HostParams<M>,
      ): Promise<HostResult<M>> => {
        if (hostId === TARGET_HOST_ID) {
          if (method === 'sessions.create') {
            sentCreateParams.push(params as HostParams<'sessions.create'>)
          }
          return targetWindow.request(method, params)
        }
        return originWindow.request(method, params)
      },
      getSessionSummary: () => undefined,
      upsertSession: () => {},
      learnSessionHost: () => {},
      readStored: () => [],
      writeStored: () => {},
      newId: () => 'rdel-perm-isolation',
      now: () => Date.now(),
    })

    const { summary: target } = await tracker.delegate({
      originSessionId: origin.id,
      originHostId: null,
      targetHostId: TARGET_HOST_ID,
      targetHostName: 'Target Mac',
      targetProjectPath: targetHost.project,
      targetProjectName: 'target',
      targetAgentId: 'fake-agent',
      targetAgentName: 'Fake agent',
      taskText: 'Check target mode',
      promptText: 'Check target mode',
    })

    // The wire payload to targetHost carries no `options`, no `mode`, and no `parentId`.
    expect(sentCreateParams).toHaveLength(1)
    expect(sentCreateParams[0]!.options).toBeUndefined()
    expect(sentCreateParams[0]!.parentId).toBeUndefined()

    // Target session uses targetHost's own permission config, never origin's Full access.
    await targetWindow.until(() => {
      const s = targetWindow.summary(target.id)
      return s !== undefined && s.status === 'ready' && s.lastTurn != null
    })
    const snapshot = await targetWindow.request('sessions.snapshot', { sessionId: target.id })
    const targetMode = snapshot.session.config.find((opt) => opt.category === 'mode')?.value
    expect(targetMode).not.toBe('bypassPermissions')
    expect(targetMode).not.toBe('agent-full-access')
    expect(targetMode).not.toBe('danger-full-access')
  })

  it('does not expose any cross-host delegation MCP tool to agents (#2700 boundary)', () => {
    const toolNames = SESSION_TOOLS.map((tool) => tool.name)
    for (const name of toolNames) {
      expect(name.toLowerCase()).not.toContain('host')
      expect(name.toLowerCase()).not.toContain('remote')
      expect(name.toLowerCase()).not.toContain('computer')
    }
  })
})
