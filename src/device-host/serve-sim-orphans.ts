// A serve-sim keeps its simulator's lock until it exits. One whose device host was killed keeps
// running under launchd and holds that lock, so the next stream of the simulator cannot start.

import type { Env } from '../agent-host/find-command'
import { run } from './discovery'

const STOP_WAIT_MS = 3_000
const POLL_MS = 50

/**
 * The serve-sims in `ps -ww -axo pid=,ppid=,command=` output that this copy of Kettu started for
 * `udid` and whose device host is gone: launchd (pid 1) took them over. A live device host's
 * serve-sim, this Kettu's or another's, is its child, and the user's own runs another script.
 */
export function orphanedServeSims(ps: string, script: string, udid: string): number[] {
  const launch = ` ${script} ${udid} --require-token `
  const pids: number[] = []
  for (const line of ps.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!match || match[2] !== '1') continue
    const pid = Number(match[1])
    if (pid > 1 && pid !== process.pid && ` ${match[3]} `.includes(launch)) pids.push(pid)
  }
  return pids
}

/** Stops the orphans of `orphanedServeSims` as their device host would have, so they free the lock. */
export async function stopOrphanedServeSims(
  script: string,
  udid: string,
  env: Env,
  log: (message: string) => void,
): Promise<void> {
  if (process.platform !== 'darwin') return
  const ps = await run('/bin/ps', ['-ww', '-axo', 'pid=,ppid=,command='], env).catch(
    (error: unknown) => {
      log(`Cannot look for a serve-sim left behind: ${String(error)}`)
      return ''
    },
  )
  await Promise.all(
    orphanedServeSims(ps, script, udid).map(async (pid) => {
      log(`Stopping serve-sim ${pid}, left behind by a device host that is gone`)
      if (!signal(pid, 'SIGTERM')) return
      if (await exited(pid, STOP_WAIT_MS)) return
      signal(pid, 'SIGKILL')
      await exited(pid, STOP_WAIT_MS)
    }),
  )
}

/** False when the process is gone already. */
function signal(pid: number, name: NodeJS.Signals | 0): boolean {
  try {
    process.kill(pid, name)
    return true
  } catch {
    return false
  }
}

async function exited(pid: number, waitMs: number): Promise<boolean> {
  for (let waited = 0; waited < waitMs; waited += POLL_MS) {
    if (!signal(pid, 0)) return true
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
  return !signal(pid, 0)
}
