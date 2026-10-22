import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatus, EnvironmentInfo } from '@shared/agent-host'

const request = vi.fn()
vi.stubGlobal('window', { overbench: { agents: { request } } })

const { useAgentsStore } = await import('./agents')

const info = (overrides: Partial<EnvironmentInfo>): EnvironmentInfo => ({
  source: 'pending',
  shell: null,
  resolvedAt: null,
  durationMs: null,
  warning: null,
  nodeVersion: null,
  npmPath: null,
  ...overrides,
})
const pending = info({})
const resolved = info({ source: 'login-shell', resolvedAt: 1_000, nodeVersion: 'v24.22.0' })

describe('agents store', () => {
  beforeEach(() => {
    request.mockReset()
    useAgentsStore.setState({ byId: {}, order: [], environment: null, loaded: false })
  })

  it('keeps an environment that resolved while the agent list was still loading', async () => {
    let answerList!: (statuses: AgentStatus[]) => void
    request.mockImplementation((method: string) =>
      method === 'agents.list'
        ? new Promise((resolve) => (answerList = resolve))
        : Promise.resolve(pending),
    )
    const refresh = useAgentsStore.getState().refresh()
    await vi.waitFor(() => expect(answerList).toBeDefined())
    // What the `environment.changed` event does once the login shell answers.
    useAgentsStore.setState({ environment: resolved })
    answerList([])
    await refresh
    expect(useAgentsStore.getState().environment).toEqual(resolved)
  })

  it('takes an environment read again after the one it holds', async () => {
    useAgentsStore.setState({ environment: resolved })
    const reloaded = info({ ...resolved, resolvedAt: 2_000, nodeVersion: 'v25.2.1' })
    request.mockImplementation((method: string) =>
      Promise.resolve(method === 'agents.environment' ? reloaded : []),
    )
    await useAgentsStore.getState().reloadEnvironment()
    expect(useAgentsStore.getState().environment).toEqual(reloaded)
  })

  it('marks an agent updated only once its update is gone', async () => {
    const codex = { id: 'codex', update: null, task: null } as unknown as AgentStatus
    request.mockResolvedValue(undefined)
    useAgentsStore.setState({ byId: { codex }, updated: {} })
    await useAgentsStore.getState().update('codex')
    expect(useAgentsStore.getState().updated).toEqual({ codex: true })
  })

  it('does not mark a cancelled update as done', async () => {
    const offered = { adapterVersion: '2.3.0', cliVersion: '0.161.0' }
    const codex = { id: 'codex', update: offered, task: null } as unknown as AgentStatus
    request.mockResolvedValue(undefined)
    useAgentsStore.setState({ byId: { codex }, updated: {} })
    await useAgentsStore.getState().update('codex')
    expect(useAgentsStore.getState().updated).toEqual({})
  })

  it('keeps a failed update check as an error, not as checked', async () => {
    request.mockRejectedValue(new Error('offline'))
    useAgentsStore.setState({ updateCheck: { running: false, finishedAt: null, error: null } })
    await useAgentsStore.getState().checkUpdates()
    expect(useAgentsStore.getState().updateCheck).toEqual({
      running: false,
      finishedAt: null,
      error: 'offline',
    })
  })
})
