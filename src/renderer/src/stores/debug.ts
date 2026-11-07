import { create } from 'zustand'
import { DEBUG_OFF, type DebugStatus } from '@shared/debug'

interface DebugStore {
  /** This run's debug mode and its ports, as main reports them. */
  status: DebugStatus
  /** The confirmation before restarting in debug mode, from Settings or a second `--debug`. */
  confirming: boolean
}

export const useDebugStore = create<DebugStore>()(() => ({ status: DEBUG_OFF, confirming: false }))

export function confirmDebugRestart(open = true): void {
  useDebugStore.setState({ confirming: open })
}

export async function initDebug(): Promise<void> {
  window.kettu.debug.onChanged((status) => useDebugStore.setState({ status }))
  useDebugStore.setState({ status: await window.kettu.debug.get() })
}
