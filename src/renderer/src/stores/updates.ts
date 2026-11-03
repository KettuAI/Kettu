import { create } from 'zustand'
import type { AgentId } from '@shared/thread'
import type { UpdateStatus } from '@shared/updates'
import { readJson, writeJson } from '@renderer/lib/storage'

interface UpdatesStore {
  status: UpdateStatus | null
  /** Set for 4 s after a check the user started found nothing. */
  justChecked: boolean
  /** Closed here, or initialized already by an earlier window of this version. */
  updatedDismissed: boolean
  /** The dialog that restarts into a downloaded update, which only Restart opens. */
  dialogOpen: boolean
  /** Harness updates asked for that wait for the harness's running sessions to end. */
  harnessWaiting: AgentId[]
  /** Harness updates asked for that wait their turn behind the one installing. */
  harnessQueued: AgentId[]
  /** The update card was closed on updates still to do, so Settings shows a dot until opened. */
  settingsDot: boolean
}

const SETTINGS_DOT_KEY = 'updates.settingsDot'
const UPDATED_NOTICE_KEY = 'updates.updatedNotice'

export const useUpdatesStore = create<UpdatesStore>()(() => ({
  status: null,
  justChecked: false,
  updatedDismissed: false,
  dialogOpen: false,
  harnessWaiting: [],
  harnessQueued: [],
  settingsDot: readJson<unknown>(SETTINGS_DOT_KEY, false) === true,
}))

/** Shows what the downloaded update brings, with Restart now and Later. */
export function openUpdateDialog(open = true): void {
  useUpdatesStore.setState({ dialogOpen: open })
}

export function setSettingsDot(on: boolean): void {
  if (useUpdatesStore.getState().settingsDot === on) return
  useUpdatesStore.setState({ settingsDot: on })
  writeJson(SETTINGS_DOT_KEY, on)
}

let justCheckedTimer: ReturnType<typeof setTimeout> | undefined

/**
 * Restart on the update card and in its list: the dialog that shows what the downloaded update
 * brings, whose Restart now installs it. Running sessions are asked about by main's quit
 * confirmation.
 */
export function restartToUpdate(): void {
  openUpdateDialog()
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

/**
 * Main keeps `updatedFrom` until the process ends, so every new window would show the completion
 * notice again. The first window records the version and still shows it; a later window of that
 * version starts dismissed. A launch with no `updatedFrom` records nothing, so the next update
 * can still show.
 */
function updatedNoticeDismissed(status: UpdateStatus): boolean {
  if (!status.updatedFrom) return false
  if (readJson<unknown>(UPDATED_NOTICE_KEY, null) === status.current) return true
  writeJson(UPDATED_NOTICE_KEY, status.current)
  return false
}

export async function initUpdates(): Promise<void> {
  window.kettu.updates.onChanged((status) => useUpdatesStore.setState({ status }))
  const status = await window.kettu.updates.getStatus()
  const updatedDismissed = updatedNoticeDismissed(status)
  useUpdatesStore.setState(updatedDismissed ? { status, updatedDismissed } : { status })
}
