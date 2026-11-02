import { create } from 'zustand'
import { useViewStore } from './view'

interface HostSwitchStore {
  /** The host the window just switched to, and the choice before it, while it connects. */
  switching: { hostId: string; from: string | null } | null
}

export const useHostSwitchStore = create<HostSwitchStore>()(() => ({ switching: null }))

/**
 * Points the window at one host, `THIS_COMPUTER` or another's id, or at every host with null. The
 * sidebar swaps to that host's projects and sessions at once; another host still connecting
 * shows a bar until it is online.
 */
export function switchHost(choice: string | null, connecting: boolean): void {
  const from = useViewStore.getState().hostFilter
  if (choice === from) return
  useViewStore.setState({ hostFilter: choice })
  useHostSwitchStore.setState({
    switching: connecting && choice !== null ? { hostId: choice, from } : null,
  })
}

/** Goes back to the choice before the switch, as Esc on the connecting bar does. */
export function cancelHostSwitch(): void {
  const { switching } = useHostSwitchStore.getState()
  if (!switching) return
  useHostSwitchStore.setState({ switching: null })
  useViewStore.setState({ hostFilter: switching.from })
}

/** The switch is over: the host connected, or stopped trying. */
export function hostSwitchSettled(): void {
  if (useHostSwitchStore.getState().switching) useHostSwitchStore.setState({ switching: null })
}
