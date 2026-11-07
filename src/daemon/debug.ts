// Debug mode for the daemon: one run with the daemon's and its hosts' Node.js inspectors open on
// 127.0.0.1. `kettu restart --debug` leaves a marker in the data folder that the service's next
// `kettu run` takes, so the run after that is a normal one again.

import { rm, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

const MARKER = 'debug-next-run'

export async function markDebugRun(data: string): Promise<void> {
  await writeFile(path.join(data, MARKER), '', { mode: 0o600 })
}

/** Removes the marker, as when the restart it was for did not happen. */
export async function unmarkDebugRun(data: string): Promise<void> {
  await rm(path.join(data, MARKER), { force: true })
}

/** Whether this run was asked to be a debug run; the marker counts for one run only. */
export async function takeDebugRun(data: string): Promise<boolean> {
  try {
    await unlink(path.join(data, MARKER))
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
