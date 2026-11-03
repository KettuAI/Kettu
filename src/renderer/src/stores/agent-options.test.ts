import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentOptions } from '@shared/agent-host'

const hostRequest = vi.fn()
vi.stubGlobal('window', {
  kettu: { agents: { request: vi.fn() }, hosts: { request: hostRequest } },
})

const {
  forgetHostAgentOptions,
  optionsLoaded,
  optionsOn,
  readHostAgentOptions,
  receiveAgentOptions,
  useAgentOptionsStore,
} = await import('./agent-options')

const devBox = 'a'.repeat(32)
const options = (agentId: string) => ({ agentId, config: [] }) as unknown as AgentOptions

describe("another host's agent options", () => {
  beforeEach(() => {
    hostRequest.mockReset()
    useAgentOptionsStore.setState({ byId: { codex: options('codex') }, loaded: true, hosts: {} })
  })

  it("keeps them apart from this computer's, followed by the host's events", async () => {
    hostRequest.mockResolvedValue([options('claude-code')])
    expect(optionsLoaded(useAgentOptionsStore.getState(), devBox)).toBe(false)
    await readHostAgentOptions(devBox)
    expect(hostRequest).toHaveBeenCalledWith(devBox, 'agents.options', undefined)
    receiveAgentOptions(options('opencode'), devBox)
    const state = useAgentOptionsStore.getState()
    expect(optionsLoaded(state, devBox)).toBe(true)
    expect(Object.keys(optionsOn(state, devBox))).toEqual(['claude-code', 'opencode'])
    expect(Object.keys(optionsOn(state, null))).toEqual(['codex'])

    forgetHostAgentOptions(devBox)
    expect(optionsLoaded(useAgentOptionsStore.getState(), devBox)).toBe(false)
  })

  it('counts a failed read as read, so the menu stops waiting', async () => {
    hostRequest.mockRejectedValue(new Error('offline'))
    await expect(readHostAgentOptions(devBox)).rejects.toThrow('offline')
    const state = useAgentOptionsStore.getState()
    expect(optionsLoaded(state, devBox)).toBe(true)
    expect(optionsOn(state, devBox)).toEqual({})
  })
})

describe('a change of the start mode', () => {
  const mode = { id: 'mode', name: 'Mode', category: 'mode', type: 'select', value: 'default' }
  const claude = (startMode?: string) =>
    ({
      agentId: 'claude-code',
      config: [mode],
      ...(startMode ? { startMode } : {}),
    }) as unknown as AgentOptions

  beforeEach(() => {
    useAgentOptionsStore.setState({
      byId: { 'claude-code': claude('plan') },
      hosts: {},
      picks: { 'claude-code': { mode: 'plan', model: 'opus' }, codex: { mode: 'agent' } },
    })
  })

  it('replaces the mode the draft kept for the agent, and nothing else', () => {
    receiveAgentOptions(claude('acceptEdits'))
    expect(useAgentOptionsStore.getState().picks).toEqual({
      'claude-code': { model: 'opus' },
      codex: { mode: 'agent' },
    })
    receiveAgentOptions(claude('acceptEdits'))
    expect(useAgentOptionsStore.getState().byId['claude-code']?.startMode).toBe('acceptEdits')
  })

  it('does the same when the start mode is cleared or first set', () => {
    receiveAgentOptions(claude())
    expect(useAgentOptionsStore.getState().picks['claude-code']).toEqual({ model: 'opus' })
    useAgentOptionsStore.setState({ picks: { 'claude-code': { mode: 'plan' } } })
    receiveAgentOptions(claude('plan'))
    expect(useAgentOptionsStore.getState().picks['claude-code']).toEqual({})
  })

  it('keeps the draft while the start mode stays', () => {
    receiveAgentOptions({ ...claude('plan'), observedAt: 5 })
    expect(useAgentOptionsStore.getState().picks['claude-code']).toEqual({
      mode: 'plan',
      model: 'opus',
    })
  })

  it('keeps the draft of an agent whose options were not known', () => {
    useAgentOptionsStore.setState({ byId: {} })
    receiveAgentOptions(claude('plan'))
    expect(useAgentOptionsStore.getState().picks['claude-code']).toEqual({
      mode: 'plan',
      model: 'opus',
    })
  })
})
