import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentOptions, SessionSummary } from '@shared/agent-host'
import type { AgentId, ConfigOption } from '@shared/thread'

const hostMock = vi.fn()
const hostAtMock = vi.fn()

vi.mock('@renderer/lib/host', () => ({
  host: (...args: unknown[]) => hostMock(...args),
  hostAt: (...args: unknown[]) => hostAtMock(...args),
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}))

vi.mock('@renderer/stores/agents', () => ({
  agentsOn: () => ({ byId: {} }),
  useAgentsStore: { getState: () => ({ byId: {}, hosts: {} }) },
}))

import {
  clearPicks,
  optionsOn,
  picksOf,
  preparedFor,
  useAgentOptionsStore,
} from '@renderer/stores/agent-options'
import { chooseWhere, useWorktreeChoice, worktreeRequest } from '@renderer/stores/worktree-choice'
import {
  prepareFor,
  preparedRemoved,
  receivePrepared,
  sessionStarted,
  setOption,
  settleOptions,
} from './prepared'
import { startValues } from './start-options'

const select = (
  id: string,
  category: ConfigOption['category'],
  value: string,
  values: string[],
): ConfigOption => ({
  id,
  name: id,
  category,
  type: 'select',
  value,
  choices: values.map((v) => ({ value: v, name: v })),
})

const claudeConfig = (mode = 'default', custom = 'off'): ConfigOption[] => [
  select('model', 'model', 'sonnet', ['sonnet', 'opus']),
  select('mode', 'mode', mode, ['default', 'acceptEdits', 'plan', 'bypassPermissions']),
  select('sandbox_net', 'other', custom, ['off', 'on']),
]

const codexConfig = (mode = 'workspace-write'): ConfigOption[] => [
  select('model', 'model', 'gpt-5', ['gpt-5']),
  select('mode', 'mode', mode, ['read-only', 'workspace-write', 'danger-full-access']),
]

function preparedSummary(
  id: string,
  agentId: AgentId,
  projectPath: string,
  config: ConfigOption[],
  openedAt = 1,
): SessionSummary {
  return {
    id,
    agentId,
    projectPath,
    title: null,
    status: 'ready',
    createdAt: openedAt,
    updatedAt: openedAt,
    lastViewedAt: null,
    parentId: null,
    origin: 'user',
    archivedAt: null,
    pinned: false,
    unread: false,
    description: null,
    branch: null,
    prepared: {
      config,
      commands: [],
      notices: [],
      openedAt,
    },
  } as unknown as SessionSummary
}

function createOptionsFor(hostId: string | null, agentId: AgentId) {
  const state = useAgentOptionsStore.getState()
  const entry = optionsOn(state, hostId)[agentId]
  const prepared = preparedFor(state, hostId, agentId)?.summary?.prepared?.config
  return startValues(entry, picksOf(state, hostId, agentId), { startMode: true, prepared })
}

function seedOptions(entries: Partial<Record<AgentId, AgentOptions>>) {
  useAgentOptionsStore.setState({
    byId: entries,
    loaded: true,
    hosts: {},
    error: null,
    picks: {},
    prepared: null,
    firstReads: {},
  })
}

describe('prepared session options across worktree switches and lifecycle', () => {
  const repo = '/tmp/project-repo'

  beforeEach(() => {
    hostMock.mockReset()
    hostAtMock.mockReset()
    useWorktreeChoice.setState({ where: {}, base: {}, slug: null, template: {}, templateError: {} })
    seedOptions({
      'claude-code': {
        agentId: 'claude-code',
        config: claudeConfig('default'),
        levels: {},
        remembered: {},
        startMode: 'acceptEdits',
        observedAt: 0,
      },
      codex: {
        agentId: 'codex',
        config: codexConfig('workspace-write'),
        levels: {},
        remembered: {},
        observedAt: 0,
      },
    })
  })

  it('preserves full access mode when selected before switching location to a new worktree', async () => {
    const initial = preparedSummary('prep-1', 'claude-code', repo, claudeConfig('acceptEdits'))
    hostMock.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === 'sessions.prepare') return initial
      if (method === 'sessions.setConfigOption') {
        const updated = preparedSummary(
          'prep-1',
          'claude-code',
          repo,
          claudeConfig(String(params.value)),
        )
        receivePrepared(updated, null)
        return undefined
      }
      if (method === 'sessions.discard') return undefined
      return undefined
    })

    prepareFor({ hostId: null, agentId: 'claude-code', projectPath: repo, parentId: null })
    await vi.waitFor(() =>
      expect(useAgentOptionsStore.getState().prepared?.summary?.id).toBe('prep-1'),
    )

    // Pick Full access on Local, settle it onto the prepared session (which clears picks.mode).
    setOption(null, 'claude-code', 'mode', 'bypassPermissions')
    await settleOptions(null, 'claude-code')
    expect(picksOf(useAgentOptionsStore.getState(), null, 'claude-code')?.mode).toBeUndefined()

    // Switch location to New worktree and compute the create options.
    chooseWhere(repo, 'worktree')
    expect(worktreeRequest(repo, 'main')).toEqual({ base: 'main' })
    expect(createOptionsFor(null, 'claude-code')).toEqual({ mode: 'bypassPermissions' })
  })

  it('preserves full access mode when switching to a new worktree before picking mode', async () => {
    const initial = preparedSummary('prep-1', 'claude-code', repo, claudeConfig('acceptEdits'))
    hostMock.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === 'sessions.prepare') return initial
      if (method === 'sessions.setConfigOption') {
        const updated = preparedSummary(
          'prep-1',
          'claude-code',
          repo,
          claudeConfig(String(params.value)),
        )
        receivePrepared(updated, null)
        return undefined
      }
      if (method === 'sessions.discard') return undefined
      return undefined
    })

    chooseWhere(repo, 'worktree')
    prepareFor({ hostId: null, agentId: 'claude-code', projectPath: repo, parentId: null })
    await vi.waitFor(() =>
      expect(useAgentOptionsStore.getState().prepared?.summary?.id).toBe('prep-1'),
    )

    setOption(null, 'claude-code', 'mode', 'bypassPermissions')
    await settleOptions(null, 'claude-code')
    expect(createOptionsFor(null, 'claude-code')).toEqual({ mode: 'bypassPermissions' })
  })

  it('gives unsettled in-flight picks precedence over the prepared session config', async () => {
    const initial = preparedSummary(
      'prep-1',
      'claude-code',
      repo,
      claudeConfig('bypassPermissions', 'on'),
    )
    let releaseSet: () => void = () => {}
    hostMock.mockImplementation(async (method: string) => {
      if (method === 'sessions.prepare') return initial
      if (method === 'sessions.setConfigOption') {
        await new Promise<void>((resolve) => {
          releaseSet = resolve
        })
        return undefined
      }
      return undefined
    })

    prepareFor({ hostId: null, agentId: 'claude-code', projectPath: repo, parentId: null })
    await vi.waitFor(() =>
      expect(useAgentOptionsStore.getState().prepared?.summary?.id).toBe('prep-1'),
    )

    setOption(null, 'claude-code', 'mode', 'plan')
    // While setConfigOption is still in flight, the unsettled pick takes priority over prepared.
    expect(createOptionsFor(null, 'claude-code')).toEqual({
      mode: 'plan',
      sandbox_net: 'on',
    })

    releaseSet()
    await settleOptions(null, 'claude-code')
  })

  it('does not leak one agent prepared config into another agent when switching agents', async () => {
    const claudePrep = preparedSummary(
      'prep-claude',
      'claude-code',
      repo,
      claudeConfig('bypassPermissions', 'on'),
    )
    const codexPrep = preparedSummary('prep-codex', 'codex', repo, codexConfig('workspace-write'))
    hostMock.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === 'sessions.prepare') {
        return params.agentId === 'codex' ? codexPrep : claudePrep
      }
      if (method === 'sessions.discard') return undefined
      return undefined
    })

    prepareFor({ hostId: null, agentId: 'claude-code', projectPath: repo, parentId: null })
    await vi.waitFor(() =>
      expect(useAgentOptionsStore.getState().prepared?.summary?.id).toBe('prep-claude'),
    )

    // Before Codex prepares, Claude's prepared session must not affect Codex's options.
    expect(createOptionsFor(null, 'codex')).toEqual({})

    prepareFor({ hostId: null, agentId: 'codex', projectPath: repo, parentId: null })
    await vi.waitFor(() =>
      expect(useAgentOptionsStore.getState().prepared?.summary?.id).toBe('prep-codex'),
    )
    expect(createOptionsFor(null, 'codex')).toEqual({ mode: 'workspace-write' })
  })

  it('discards an unadopted prepared session after start without leaking mode to the next session', async () => {
    const first = preparedSummary('prep-1', 'claude-code', repo, claudeConfig('acceptEdits'))
    const second = preparedSummary('prep-2', 'claude-code', repo, claudeConfig('acceptEdits'), 2)
    let prepareCount = 0
    const prepareCalls: Record<string, unknown>[] = []
    const discardCalls: string[] = []
    hostMock.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === 'sessions.prepare') {
        prepareCalls.push(params)
        prepareCount += 1
        return prepareCount === 1 ? first : second
      }
      if (method === 'sessions.setConfigOption') {
        receivePrepared(
          preparedSummary('prep-1', 'claude-code', repo, claudeConfig(String(params.value))),
          null,
        )
        return undefined
      }
      if (method === 'sessions.discard') {
        discardCalls.push(String(params.sessionId))
        return undefined
      }
      return undefined
    })

    prepareFor({ hostId: null, agentId: 'claude-code', projectPath: repo, parentId: null })
    await vi.waitFor(() =>
      expect(useAgentOptionsStore.getState().prepared?.summary?.id).toBe('prep-1'),
    )

    setOption(null, 'claude-code', 'mode', 'bypassPermissions')
    await settleOptions(null, 'claude-code')
    expect(createOptionsFor(null, 'claude-code')).toEqual({ mode: 'bypassPermissions' })

    // A worktree session started with a brand-new id (not adopting prep-1).
    sessionStarted(null, 'claude-code', 'worktree-session-1')
    clearPicks(null, 'claude-code')

    expect(useAgentOptionsStore.getState().prepared).toBeNull()
    expect(discardCalls).toEqual(['prep-1'])
    // The corresponding session.removed event must not copy the old mode into picks.
    expect(preparedRemoved('prep-1')).toBe(true)
    expect(picksOf(useAgentOptionsStore.getState(), null, 'claude-code')).toBeUndefined()

    // The next New session prepares fresh with no leaked mode pick and uses default startMode.
    prepareFor({ hostId: null, agentId: 'claude-code', projectPath: repo, parentId: null })
    await vi.waitFor(() =>
      expect(useAgentOptionsStore.getState().prepared?.summary?.id).toBe('prep-2'),
    )
    expect(prepareCalls[1]?.options).toBeUndefined()
    expect(createOptionsFor(null, 'claude-code')).toEqual({ mode: 'acceptEdits' })
  })

  it('does not discard an adopted prepared session and discards an in-flight prepare after start', async () => {
    const adopted = preparedSummary('prep-adopted', 'claude-code', repo, claudeConfig('default'))
    const discardCalls: string[] = []
    hostMock.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === 'sessions.prepare') return adopted
      if (method === 'sessions.discard') {
        discardCalls.push(String(params.sessionId))
        return undefined
      }
      return undefined
    })

    prepareFor({ hostId: null, agentId: 'claude-code', projectPath: repo, parentId: null })
    await vi.waitFor(() =>
      expect(useAgentOptionsStore.getState().prepared?.summary?.id).toBe('prep-adopted'),
    )

    sessionStarted(null, 'claude-code', 'prep-adopted')
    expect(useAgentOptionsStore.getState().prepared).toBeNull()
    expect(discardCalls).toEqual([])

    // Now simulate a worktree start completing while a fresh prepare with a mode pick is in flight.
    let resolveInFlight: (summary: SessionSummary) => void = () => {}
    hostMock.mockImplementation((method: string, params: Record<string, unknown>) => {
      if (method === 'sessions.prepare') {
        return new Promise<SessionSummary>((resolve) => {
          resolveInFlight = resolve
        })
      }
      if (method === 'sessions.discard') {
        discardCalls.push(String(params.sessionId))
        return Promise.resolve(undefined)
      }
      return Promise.resolve(undefined)
    })

    setOption(null, 'claude-code', 'mode', 'bypassPermissions')
    prepareFor({ hostId: null, agentId: 'claude-code', projectPath: repo, parentId: null })
    sessionStarted(null, 'claude-code', 'worktree-session-2')
    clearPicks(null, 'claude-code')

    resolveInFlight(
      preparedSummary('prep-late', 'claude-code', repo, claudeConfig('bypassPermissions'), 3),
    )
    await vi.waitFor(() => expect(discardCalls).toEqual(['prep-late']))
    expect(useAgentOptionsStore.getState().prepared).toBeNull()
    expect(picksOf(useAgentOptionsStore.getState(), null, 'claude-code')).toBeUndefined()
  })
})
