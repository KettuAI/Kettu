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
