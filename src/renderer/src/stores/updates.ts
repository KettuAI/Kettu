import { create } from 'zustand'
import type { UpdateStatus } from '@shared/updates'

interface UpdatesStore {
  status: UpdateStatus | null
  /** Set for 4 s after a check the user started found nothing. */
  justChecked: boolean
  /** The "Updated to" notice was dismissed; it shows for one launch only anyway. */
  updatedDismissed: boolean
}

export const useUpdatesStore = create<UpdatesStore>()(() => ({
  status: null,
  justChecked: false,
  updatedDismissed: false,
}))

let justCheckedTimer: ReturnType<typeof setTimeout> | undefined

export async function checkForUpdates(): Promise<void> {
  const status = await window.overbench.updates.check()
  useUpdatesStore.setState({ status })
  if (status.state.kind === 'idle') {
    clearTimeout(justCheckedTimer)
    useUpdatesStore.setState({ justChecked: true })
    justCheckedTimer = setTimeout(() => useUpdatesStore.setState({ justChecked: false }), 4000)
  }
}

export async function initUpdates(): Promise<void> {
  window.overbench.updates.onChanged((status) => useUpdatesStore.setState({ status }))
  useUpdatesStore.setState({ status: await window.overbench.updates.getStatus() })
}
