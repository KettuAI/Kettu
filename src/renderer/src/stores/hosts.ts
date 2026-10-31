import { create } from 'zustand'
import type { HostsStatus } from '@shared/remote/hosts'

interface HostsStore {
  /** Other hosts this computer connects to, and this computer; null until the first read. */
  status: HostsStatus | null
}

export const useHostsStore = create<HostsStore>()(() => ({ status: null }))

/** Follows main's changes; called once at bootstrap. */
export function initHosts(): void {
  window.kettu.hosts.onChanged((status) => useHostsStore.setState({ status }))
}

/** Reads the status, as Settings does when it opens, which also reads the computer's model. */
export async function loadHosts(): Promise<void> {
  try {
    useHostsStore.setState({ status: await window.kettu.hosts.status() })
  } catch (error) {
    console.error('Could not read the hosts', error)
  }
}
