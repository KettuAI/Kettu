import { create } from 'zustand'
import { leaveSessionOffHost } from '@renderer/app/actions'
import { otherHosts, useHostsStore } from './hosts'
import { THIS_COMPUTER, useViewStore } from './view'

interface HostSwitchStore {
  /** The host the window just switched to, and the choice before it, while it connects. */
  switching: { hostId: string; from: string | null } | null
}

export const useHostSwitchStore = create<HostSwitchStore>()(() => ({ switching: null }))

/**
 * Points the window at one host, `THIS_COMPUTER` or another's id, or at every host with null. The
 * sidebar swaps to that host's projects and sessions at once. A session shown from another host
 * is left then, or, while the host chosen still connects, once it is online or stops trying, so
 * that cancelling the switch finds it still there; meanwhile a bar shows the host connecting.
 */
export function switchHost(choice: string | null, connecting: boolean): void {
  const from = useViewStore.getState().hostFilter
  if (choice === from) return
  useViewStore.setState({ hostFilter: choice })
  if (connecting && choice !== null) {
    useHostSwitchStore.setState({ switching: { hostId: choice, from } })
    return
  }
  useHostSwitchStore.setState({ switching: null })
  if (choice !== null) leaveSessionOffHost(choice === THIS_COMPUTER ? null : choice)
}

/** Goes back to the choice before the switch, as Esc on the connecting bar does. */
export function cancelHostSwitch(): void {
  const { switching } = useHostSwitchStore.getState()
  if (!switching) return
  useHostSwitchStore.setState({ switching: null })
  useViewStore.setState({ hostFilter: switching.from })
}

/** The switch is over: the host connected, or stopped trying, and the window leaves for it. */
export function hostSwitchSettled(): void {
  const { switching } = useHostSwitchStore.getState()
  if (!switching) return
  useHostSwitchStore.setState({ switching: null })
  if (useViewStore.getState().hostFilter === switching.hostId) {
    leaveSessionOffHost(switching.hostId)
  }
}

// Settles here rather than in the bar, which a collapsed sidebar does not show.
useHostsStore.subscribe((state) => {
  const { switching } = useHostSwitchStore.getState()
  if (!switching) return
  const host = otherHosts(state).find((h) => h.id === switching.hostId)
  if (host?.connection.state !== 'connecting') hostSwitchSettled()
})
