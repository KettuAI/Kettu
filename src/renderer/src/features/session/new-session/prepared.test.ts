import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@shared/agent-host'
import type { ConfigOption } from '@shared/thread'

const request = vi.fn()
vi.stubGlobal('window', {
  kettu: { agents: { request }, perf: false },
  matchMedia: () => ({ matches: false, addEventListener: () => {} }),
})

const {
  adoptedPrepared,
  discardPrepared,
  enterNewSession,
  leaveNewSession,
  prepareFor,
  preparedRemoved,
  readFirstOptions,
  receivePrepared,
  setOption,
  settleOptions,
} = await import('./prepared')
const { useAgentOptionsStore } = await import('@renderer/stores/agent-options')

const model = (value: string): ConfigOption => ({
  id: 'model',
  name: 'Model',
  category: 'model',
  type: 'select',
  value,
  choices: [
    { value: 'small', name: 'Small' },
    { value: 'large', name: 'Large' },
  ],
})

const prepared = (id: string, value = 'small', openedAt = 1): SessionSummary =>
  ({
    id,
    agentId: 'codex',
    projectPath: '/repo',
    status: 'ready',
    prepared: { config: [model(value)], notices: [], openedAt },
  }) as unknown as SessionSummary

const target = { agentId: 'codex', projectPath: '/repo', parentId: null } as const
const calls = (method: string) =>
  request.mock.calls.filter(([m]) => m === method).map(([, params]) => params as unknown)

describe('prepared sessions in New session', () => {
  beforeEach(() => {
    request.mockReset()
    useAgentOptionsStore.setState({ prepared: null, picks: {} })
    discardPrepared()
    request.mockReset()
  })

  it('opens one for what New session shows, and reuses it for the same', async () => {
    request.mockResolvedValue(prepared('p1'))
    prepareFor(target)
    prepareFor(target)
    await vi.waitFor(() => expect(useAgentOptionsStore.getState().prepared?.summary?.id).toBe('p1'))
    expect(calls('sessions.prepare')).toHaveLength(1)
  })

  it('discards the one held when the agent or folder changes', async () => {
    request.mockResolvedValue(prepared('p1'))
    prepareFor(target)
    await vi.waitFor(() => expect(useAgentOptionsStore.getState().prepared?.summary).toBeTruthy())
    request.mockResolvedValue(prepared('p2'))
    prepareFor({ ...target, projectPath: '/other' })
    expect(calls('sessions.discard')).toEqual([{ sessionId: 'p1' }])
  })

  it('takes a replacement the host opened after the settings changed, not an older one', async () => {
    request.mockResolvedValue(prepared('p1', 'small', 5))
    prepareFor(target)
    await vi.waitFor(() => expect(useAgentOptionsStore.getState().prepared?.summary).toBeTruthy())
    receivePrepared(prepared('old', 'large', 1))
    expect(useAgentOptionsStore.getState().prepared?.summary?.id).toBe('p1')
    receivePrepared(prepared('p2', 'large', 9))
    expect(useAgentOptionsStore.getState().prepared?.summary?.id).toBe('p2')
  })

  it('prepares again when the one held goes while New session shows', async () => {
    request.mockResolvedValue(prepared('q1'))
    enterNewSession()
    prepareFor(target)
    await vi.waitFor(() => expect(useAgentOptionsStore.getState().prepared?.summary).toBeTruthy())
    request.mockResolvedValue(prepared('q2'))
    expect(preparedRemoved('q1')).toBe(true)
    await vi.waitFor(() => expect(useAgentOptionsStore.getState().prepared?.summary?.id).toBe('q2'))
    leaveNewSession()
  })

  it('takes its own discard for no exit', async () => {
    request.mockResolvedValue(prepared('p1'))
    prepareFor(target)
    await vi.waitFor(() => expect(useAgentOptionsStore.getState().prepared?.summary).toBeTruthy())
    discardPrepared()
    request.mockClear()
    expect(preparedRemoved('p1')).toBe(true)
    expect(calls('sessions.prepare')).toHaveLength(0)
  })

  it('sets a choice on it, shown at once until the agent answers', async () => {
    request.mockResolvedValue(prepared('p1'))
    prepareFor(target)
    await vi.waitFor(() => expect(useAgentOptionsStore.getState().prepared?.summary).toBeTruthy())
    let answer: () => void = () => {}
    request.mockImplementation(() => new Promise<void>((resolve) => (answer = resolve)))
    setOption('codex', 'model', 'large')
    expect(useAgentOptionsStore.getState().picks.codex).toEqual({ model: 'large' })
    expect(calls('sessions.setConfigOption')).toEqual([
      { sessionId: 'p1', optionId: 'model', value: 'large' },
    ])
    const settled = settleOptions()
    answer()
    await settled
    expect(useAgentOptionsStore.getState().picks.codex).toEqual({})
  })

  it('sends the picks made before it opened with the request', async () => {
    setOption('codex', 'model', 'large')
    request.mockResolvedValue(prepared('p1', 'large'))
    prepareFor(target)
    expect(calls('sessions.prepare')).toEqual([
      { agentId: 'codex', projectPath: '/repo', options: { model: 'large' } },
    ])
    await vi.waitFor(() => expect(useAgentOptionsStore.getState().picks.codex).toEqual({}))
  })

  it('lets go of it once adopted, without discarding it', async () => {
    request.mockResolvedValue(prepared('p1'))
    prepareFor(target)
    await vi.waitFor(() => expect(useAgentOptionsStore.getState().prepared?.summary).toBeTruthy())
    adoptedPrepared('p1')
    expect(useAgentOptionsStore.getState().prepared).toBeNull()
    expect(calls('sessions.discard')).toEqual([])
  })
})

describe('first options before New session has a folder', () => {
  const options = { agentId: 'codex' } as never

  beforeEach(() => {
    request.mockReset()
    useAgentOptionsStore.setState({ byId: {}, loaded: true, firstReads: {} })
  })

  it('reads nothing before the cache has loaded, or for an agent it holds', async () => {
    useAgentOptionsStore.setState({ loaded: false })
    await readFirstOptions('codex')
    useAgentOptionsStore.setState({ loaded: true, byId: { codex: options } })
    await readFirstOptions('codex')
    expect(calls('agents.readFirstOptions')).toEqual([])
  })

  it('reads once per agent, while it reads and after it has', async () => {
    request.mockResolvedValue(undefined)
    const first = readFirstOptions('codex')
    expect(useAgentOptionsStore.getState().firstReads.codex).toEqual({
      reading: true,
      error: null,
    })
    await readFirstOptions('codex')
    await first
    await readFirstOptions('codex')
    expect(calls('agents.readFirstOptions')).toEqual([{ agentId: 'codex' }])
    expect(useAgentOptionsStore.getState().firstReads.codex).toEqual({
      reading: false,
      error: null,
    })
  })

  it('keeps the reason of a failed read until a retry reads again', async () => {
    request.mockRejectedValueOnce(new Error('Codex gave no models within 15 s'))
    await readFirstOptions('codex')
    expect(useAgentOptionsStore.getState().firstReads.codex).toEqual({
      reading: false,
      error: 'Codex gave no models within 15 s',
    })
    await readFirstOptions('codex')
    expect(calls('agents.readFirstOptions')).toHaveLength(1)
    request.mockResolvedValueOnce(undefined)
    await readFirstOptions('codex', true)
    expect(calls('agents.readFirstOptions')).toHaveLength(2)
    expect(useAgentOptionsStore.getState().firstReads.codex?.error).toBeNull()
  })
})
