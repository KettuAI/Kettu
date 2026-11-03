import { beforeEach, describe, expect, it } from 'vitest'
import { cancelHostSwitch, hostSwitchSettled, switchHost, useHostSwitchStore } from './host-switch'
import { THIS_COMPUTER, useViewStore } from './view'

beforeEach(() => {
  useViewStore.setState({ hostFilter: THIS_COMPUTER })
  useHostSwitchStore.setState({ switching: null })
})

describe('switching the host a window controls', () => {
  it('swaps the sidebar at once, and notes a host still connecting', () => {
    switchHost('dev-box', true)
    expect(useViewStore.getState().hostFilter).toBe('dev-box')
    expect(useHostSwitchStore.getState().switching).toEqual({
      hostId: 'dev-box',
      from: THIS_COMPUTER,
    })
    hostSwitchSettled()
    expect(useHostSwitchStore.getState().switching).toBeNull()
    expect(useViewStore.getState().hostFilter).toBe('dev-box')
  })

  it('shows no bar for a host online, or for every host', () => {
    switchHost('dev-box', false)
    expect(useHostSwitchStore.getState().switching).toBeNull()
    switchHost(null, true)
    expect(useViewStore.getState().hostFilter).toBeNull()
    expect(useHostSwitchStore.getState().switching).toBeNull()
  })

  it('goes back to the host before on Esc', () => {
    switchHost('dev-box', true)
    cancelHostSwitch()
    expect(useViewStore.getState().hostFilter).toBe(THIS_COMPUTER)
    expect(useHostSwitchStore.getState().switching).toBeNull()
  })

  it('changes nothing when the host is already the one shown', () => {
    switchHost(THIS_COMPUTER, true)
    expect(useHostSwitchStore.getState().switching).toBeNull()
  })
})
