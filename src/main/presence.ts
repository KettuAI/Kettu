// Whether the user is at this computer: its screen unlocked and input within the last two
// minutes. While they are, the app's own notifications tell them, and devices that want to hear
// only while the user is away wait until they leave.

import { powerMonitor } from 'electron'

/** Input within this long counts as being at the computer. */
const IDLE_SECONDS = 120
/** How often the idle time is read; leaving is noticed at most this late. */
const POLL_MS = 15_000

/** Calls `changed` with the first reading and each change; the returned function stops it. */
export function watchPresence(changed: (present: boolean) => void): () => void {
  let last: boolean | null = null
  const report = (present: boolean): void => {
    if (present === last) return
    last = present
    changed(present)
  }
  const read = (): void => report(powerMonitor.getSystemIdleState(IDLE_SECONDS) === 'active')
  const away = (): void => report(false)
  const timer = setInterval(read, POLL_MS)
  powerMonitor.on('lock-screen', away)
  powerMonitor.on('suspend', away)
  powerMonitor.on('unlock-screen', read)
  powerMonitor.on('resume', read)
  read()
  return () => {
    clearInterval(timer)
    powerMonitor.off('lock-screen', away)
    powerMonitor.off('suspend', away)
    powerMonitor.off('unlock-screen', read)
    powerMonitor.off('resume', read)
  }
}
