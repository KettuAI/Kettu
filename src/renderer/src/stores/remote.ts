import { create } from 'zustand'
import type { RemoteStatus } from '@shared/remote/status'

interface RemoteStore {
  /** What main has: whether remote access runs, and the devices; null until the first read. */
  status: RemoteStatus | null
}

export const useRemoteStore = create<RemoteStore>()(() => ({ status: null }))

/** Reads the status and follows main's changes; called once at bootstrap. */
export async function initRemote(): Promise<void> {
  window.kettu.remote.onChanged((status) => useRemoteStore.setState({ status }))
  try {
    useRemoteStore.setState({ status: await window.kettu.remote.status() })
  } catch (error) {
    console.error('Could not read the remote access status', error)
  }
}
