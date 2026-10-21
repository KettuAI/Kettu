// Spawning and stopping one agent process, by each platform's rules.

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import type { Platform } from '@shared/platform'
import { processTransport, type AcpTransport } from './acp/connection'
import type { LaunchSpec } from './catalog'
import type { Env } from './find-command'
import { quoteCmd } from './quote'

export interface ExitInfo {
  code: number | null
  signal: string | null
  /** Set when the process could not be started at all. */
  error?: string
}

export interface StopTimings {
  /** How long an agent gets to exit after its stdin closes. */
  eofMs: number
  /** How long after SIGTERM before SIGKILL, on macOS and Linux. */
  termMs: number
}

export const STOP_TIMINGS: StopTimings = { eofMs: 2_000, termMs: 3_000 }

export interface SpawnedAgent {
  readonly pid: number | null
  readonly transport: AcpTransport
  readonly exited: Promise<ExitInfo>
  readonly hasExited: boolean
  /** EOF, then SIGTERM to the process group or `taskkill /T /F`, then SIGKILL. */
  stop(): Promise<ExitInfo>
  /** After an unexpected exit: terminates what is left of the process group. */
  reap(): void
}

export interface SpawnOptions {
  platform: Platform
  env: Env
  cwd: string
  onStderr(text: string): void
  onEvent?(event: string, detail?: string): void
  timings?: StopTimings
}

/**
 * Node.js refuses to spawn `.cmd` and `.bat` files without a shell (CVE-2024-27980), so
 * those go through cmd.exe as one quoted line. Every word comes from the catalog or a
 * program the user picked in a native dialog, never from typed text.
 */
export function spawnArguments(spec: LaunchSpec): { file: string; args: string[]; shell: boolean } {
  if (!spec.shell) return { file: spec.command, args: spec.args, shell: false }
  return { file: [spec.command, ...spec.args].map(quoteCmd).join(' '), args: [], shell: true }
}

function waitForExit(exited: Promise<ExitInfo>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms)
    void exited.then(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return
  try {
    // A negative pid addresses the process group the detached child leads.
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // Already gone.
    }
  }
}

/** Kills a process tree on Windows, which has no process groups. */
export function taskkill(pid: number): Promise<void> {
  return new Promise((resolve) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve())
  })
}

export function spawnAgent(spec: LaunchSpec, options: SpawnOptions): SpawnedAgent {
  const { platform } = options
  const timings = options.timings ?? STOP_TIMINGS
  const { file, args, shell } = spawnArguments(spec)
  const child = spawn(file, args, {
    cwd: options.cwd,
    env: { ...options.env, ...spec.env } as NodeJS.ProcessEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    // Its own process group on macOS and Linux, so the whole tree can be stopped together.
    detached: platform !== 'win32',
    windowsHide: true,
    shell,
  })
  let hasExited = false
  const exited = new Promise<ExitInfo>((resolve) => {
    child.once('error', (error) => {
      // 'error' without a pid means the spawn failed; with one, 'exit' still follows.
      if (!child.pid) {
        hasExited = true
        resolve({ code: null, signal: null, error: error.message })
      } else {
        options.onEvent?.('process error', error.message)
      }
    })
    child.once('exit', (code, signal) => {
      hasExited = true
      resolve({ code, signal })
    })
  })
  // A write to an exited agent fails with EPIPE; the exit itself is what reports it.
  child.stdin.on('error', (error) => options.onEvent?.('stdin error', error.message))
  child.stderr.setEncoding('utf8').on('data', (text: string) => options.onStderr(text))

  let stopping: Promise<ExitInfo> | null = null
  const stop = (): Promise<ExitInfo> => {
    stopping ??= (async () => {
      if (!hasExited) {
        child.stdin.end()
        if (!(await waitForExit(exited, timings.eofMs))) {
          if (platform === 'win32') {
            options.onEvent?.('taskkill')
            if (child.pid) await taskkill(child.pid)
            await waitForExit(exited, timings.termMs)
          } else {
            options.onEvent?.('SIGTERM')
            signalGroup(child, 'SIGTERM')
            if (!(await waitForExit(exited, timings.termMs))) {
              options.onEvent?.('SIGKILL')
              signalGroup(child, 'SIGKILL')
              await waitForExit(exited, timings.termMs)
            }
          }
        }
      }
      reapGroup()
      return hasExited ? exited : { code: null, signal: null, error: 'did not exit after SIGKILL' }
    })()
    return stopping
  }

  // Children the agent left behind in its group go too; Windows cannot find them once the
  // parent is gone.
  const reapGroup = (): void => {
    if (platform !== 'win32') signalGroup(child, 'SIGTERM')
  }

  return {
    pid: child.pid ?? null,
    transport: processTransport(child.stdin, child.stdout),
    exited,
    get hasExited() {
      return hasExited
    },
    stop,
    reap: reapGroup,
  }
}
