import { execFile } from 'node:child_process'
import type { Platform } from '@shared/platform'

export interface ProcessTreeKiller {
  platform: Platform
  /** `process.kill`; a negative pid addresses a process group. */
  kill(pid: number, signal: NodeJS.Signals | 0): void
  run(command: string, args: string[]): Promise<void>
  delay(ms: number): Promise<void>
}

const defaultKiller: ProcessTreeKiller = {
  platform: process.platform,
  kill: (pid, signal) => process.kill(pid, signal),
  run: (command, args) =>
    new Promise((resolve, reject) => {
      execFile(command, args, { windowsHide: true }, (error) => (error ? reject(error) : resolve()))
    }),
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

export const GRACE_MS = 2000

function groupAlive(killer: ProcessTreeKiller, pid: number): boolean {
  try {
    killer.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Stops the process tree of each pid. Agents run in their own process group on macOS and Linux,
 * so the group gets SIGTERM and, if it is still there after 2 s, SIGKILL; Windows has no groups,
 * so `taskkill /T /F` walks the tree. Resolves with the pids that could not be signalled.
 */
export async function killProcessTrees(
  pids: number[],
  killer: ProcessTreeKiller = defaultKiller,
): Promise<{ pid: number; error: string }[]> {
  const failures: { pid: number; error: string }[] = []
  await Promise.all(
    pids.map(async (pid) => {
      if (!Number.isInteger(pid) || pid <= 0) {
        failures.push({ pid, error: 'invalid pid' })
        return
      }
      if (killer.platform === 'win32') {
        try {
          await killer.run('taskkill', ['/PID', String(pid), '/T', '/F'])
        } catch (error) {
          failures.push({ pid, error: (error as Error).message })
        }
        return
      }
      try {
        killer.kill(-pid, 'SIGTERM')
      } catch (error) {
        // ESRCH: the group is already gone, which is the outcome we want.
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          failures.push({ pid, error: (error as Error).message })
        }
        return
      }
      await killer.delay(GRACE_MS)
      if (!groupAlive(killer, pid)) return
      try {
        killer.kill(-pid, 'SIGKILL')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          failures.push({ pid, error: (error as Error).message })
        }
      }
    }),
  )
  return failures
}
