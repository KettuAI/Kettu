// Which device's remove confirmation is open, so a way in from outside its page can open it too.

import { create } from 'zustand'
import { useSettingsHostStore } from '@renderer/stores/host-scope'
import { useViewStore } from '@renderer/stores/view'
import { openHostSettingsItem } from './host-sections'

/** The device, on a host (null for this window's own), whose remove confirmation is open. */
export const useDeviceRemove = create<{ open: { hostId: string | null; id: string } | null }>()(
  () => ({ open: null }),
)

/** Opens a device's page with its remove confirmation, as removing a device always asks first. */
export function askRemoveDevice(hostId: string | null, id: string): void {
  useDeviceRemove.setState({ open: { hostId, id } })
  openHostSettingsItem(hostId, 'remote', id)
}

// Leaving the device's page closes it, also one asked for before the device was listed.
useViewStore.subscribe(({ settings }) => {
  const { open } = useDeviceRemove.getState()
  if (!open) return
  if (!settings.open || settings.section !== 'remote' || settings.item !== open.id) {
    useDeviceRemove.setState({ open: null })
  }
})
useSettingsHostStore.subscribe(({ hostId }) => {
  const { open } = useDeviceRemove.getState()
  if (open && open.hostId !== hostId) useDeviceRemove.setState({ open: null })
})
