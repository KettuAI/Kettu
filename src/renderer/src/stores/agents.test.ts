import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatus, EnvironmentInfo } from '@shared/agent-host'

const request = vi.fn()
vi.stubGlobal('window', { kettu: { agents: { request } } })

const { hasProgram, useAgentsStore } = await import('./agents')

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

  it('says why an update did not run when no failed task says it', async () => {
    const codex = { id: 'codex', update: null, task: null } as unknown as AgentStatus
    request.mockImplementation((method: string) =>
      method === 'agents.update'
        ? Promise.reject(new Error('Codex has no update to install'))
        : Promise.resolve(undefined),
    )
    useAgentsStore.setState({ byId: { codex }, updated: {}, taskErrors: {} })
    await expect(useAgentsStore.getState().update('codex')).resolves.toBeUndefined()
    expect(useAgentsStore.getState().taskErrors).toEqual({
      codex: { kind: 'update', message: 'Codex has no update to install' },
    })
    expect(useAgentsStore.getState().updated).toEqual({})
  })

  it('leaves the reason to a failed task when the host reports one', async () => {
    const task = { kind: 'install', state: 'failed', method: 'npm', error: 'EACCES' }
    const opencode = { id: 'opencode', task } as unknown as AgentStatus
    request.mockRejectedValue(new Error('EACCES'))
    useAgentsStore.setState({ byId: { opencode }, taskErrors: {} })
    await useAgentsStore.getState().install('opencode', 'npm')
    expect(request).toHaveBeenCalledWith('agents.install', { agentId: 'opencode', method: 'npm' })
    expect(useAgentsStore.getState().taskErrors).toEqual({})
  })

  it('clears a reason once dismissed, or once the host reports a task', async () => {
    request.mockResolvedValue(undefined)
    const error = { kind: 'install' as const, message: 'busy' }
    useAgentsStore.setState({ taskErrors: { codex: error, opencode: error } })
    await useAgentsStore.getState().cancelTask('codex')
    expect(request).toHaveBeenCalledWith('agents.cancelTask', { agentId: 'codex' })
    const running = { kind: 'install', state: 'running' }
    useAgentsStore.getState().setOne({ id: 'opencode', task: running } as unknown as AgentStatus)
    expect(useAgentsStore.getState().taskErrors).toEqual({})
  })

  it("lists an agent beside its harness's others, as it comes and goes", () => {
    const status = (id: string) => ({ id }) as AgentStatus
    const { setAll, setOne, remove } = useAgentsStore.getState()
    setAll([status('codex'), status('claude-code'), status('opencode')])
    expect(useAgentsStore.getState().order).toEqual(['claude-code', 'codex', 'opencode'])
    setOne(status('claude-code~work'))
    expect(useAgentsStore.getState().order).toEqual([
      'claude-code',
      'claude-code~work',
      'codex',
      'opencode',
    ])
    remove('claude-code~work')
    expect(useAgentsStore.getState().order).toEqual(['claude-code', 'codex', 'opencode'])
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

  it('counts an agent whose program is too old as on the machine, not one that is missing', () => {
    const status = (overrides: Partial<AgentStatus>) =>
      ({ id: 'claude-code', state: 'not-installed', cli: null, ...overrides }) as AgentStatus
    const cli = (installed: unknown) => ({ command: 'claude', installed }) as AgentStatus['cli']
    const tooOld = { path: '/x/claude', version: '2.1.310', variable: null }
    expect(hasProgram(status({ state: 'available' }))).toBe(true)
    expect(
      hasProgram(
        status({ cli: cli({ ...tooOld, problem: { kind: 'too-old', minimum: '2.1.314' } }) }),
      ),
    ).toBe(true)
    expect(hasProgram(status({ cli: cli(null) }))).toBe(false)
    expect(hasProgram(status({}))).toBe(false)
  })
})
