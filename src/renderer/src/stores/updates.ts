import { create } from 'zustand'
import type { AgentId } from '@shared/thread'
import type { UpdateStatus } from '@shared/updates'
import { readJson, writeJson } from '@renderer/lib/storage'

interface UpdatesStore {
  status: UpdateStatus | null
  /** Set for 4 s after a check the user started found nothing. */
  justChecked: boolean
  /** The "Updated to" notice was dismissed; it shows for one launch only anyway. */
  updatedDismissed: boolean
  /** Harness updates asked for that wait for the harness's running sessions to end. */
  harnessWaiting: AgentId[]
  /** Harness updates asked for that wait their turn behind the one installing. */
  harnessQueued: AgentId[]
  /** The update card was closed on updates still to do, so Settings shows a dot until opened. */
  settingsDot: boolean
}

const SETTINGS_DOT_KEY = 'updates.settingsDot'

export const useUpdatesStore = create<UpdatesStore>()(() => ({
  status: null,
  justChecked: false,
  updatedDismissed: false,
  harnessWaiting: [],
  harnessQueued: [],
  settingsDot: readJson<unknown>(SETTINGS_DOT_KEY, false) === true,
}))

export function setSettingsDot(on: boolean): void {
  if (useUpdatesStore.getState().settingsDot === on) return
  useUpdatesStore.setState({ settingsDot: on })
  writeJson(SETTINGS_DOT_KEY, on)
}

let justCheckedTimer: ReturnType<typeof setTimeout> | undefined

/**
 * Restart on the update card and in its list: the restart that installs the downloaded update.
 * Running sessions are asked about by main's quit confirmation.
 */
export function restartToUpdate(): void {
  void window.kettu.updates.restart()
}

export async function checkForUpdates(): Promise<void> {
  const status = await window.kettu.updates.check()
  useUpdatesStore.setState({ status })
  if (status.state.kind === 'idle') {
    clearTimeout(justCheckedTimer)
    useUpdatesStore.setState({ justChecked: true })
    justCheckedTimer = setTimeout(() => useUpdatesStore.setState({ justChecked: false }), 4000)
  }
}

export async function initUpdates(): Promise<void> {
  window.kettu.updates.onChanged((status) => useUpdatesStore.setState({ status }))
  useUpdatesStore.setState({ status: await window.kettu.updates.getStatus() })
}
