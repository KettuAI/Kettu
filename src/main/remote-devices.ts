// The paired devices while the remote host does not serve them: main reads and changes the
// remote host's device and activity files itself, so Settings lists, renames and removes devices
// with remote access off.

import type { DeviceActivity } from '@shared/remote/activity'
import { normalizeDeviceName, type PairedDevice } from '@shared/remote/device'
import type { LogFn } from '../agent-host/storage'
import { ActivityLog } from '../remote-host/activity'
import { DeviceStore } from '../remote-host/devices'

export interface StoredDevices {
  list(): PairedDevice[]
  /** False when there is no such device or nothing of the name is left once cleaned up. */
  rename(id: string, name: string): Promise<boolean>
  remove(id: string): Promise<boolean>
  /** Newest first. */
  activity(id: string): DeviceActivity[]
  /** Writes what loading left to write, as old events going, before the remote host reads. */
  flush(): Promise<void>
}

export async function loadStoredDevices(userDataPath: string, log: LogFn): Promise<StoredDevices> {
  const [devices, activity] = await Promise.all([
    DeviceStore.load(userDataPath, log),
    ActivityLog.load(userDataPath, log),
  ])
  return {
    list: () => devices.list(),
    async rename(id, name) {
      const kept = normalizeDeviceName(name)
      const before = devices.get(id)
      if (!kept || !before) return false
      if (kept === before.name) return true
      if (!(await devices.rename(id, kept))) return false
      activity.record(id, { kind: 'renamed', from: before.name, to: kept, by: 'owner' })
      await activity.flush()
      return true
    },
    async remove(id) {
      if (!(await devices.remove(id))) return false
      activity.record(id, { kind: 'removed', by: 'owner' })
      await activity.flush()
      return true
    },
    activity: (id) => activity.list(id),
    flush: async () => {
      await Promise.all([devices.flush(), activity.flush()])
    },
  }
}
