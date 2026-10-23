// Spawning and stopping one agent process, by each platform's rules.

import { spawn } from 'node:child_process'
import type { Platform } from '@shared/platform'
import { processTransport, type AcpTransport } from './acp/connection'
import type { LaunchSpec } from './catalog'
import type { Env } from './find-command'
import { killSurvivors, processControl, terminateTrees, type ProcessControl } from './process-tree'
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
  /** When it was spawned, which names it apart from a later process with its pid. */
  readonly startedAt: number
  readonly transport: AcpTransport
  readonly exited: Promise<ExitInfo>
  readonly hasExited: boolean
  /**
   * EOF; then, if it still runs, SIGTERM to its whole process tree and SIGKILL to what is left,
   * or `taskkill /T /F` on Windows. What it leaves behind once it exits is `AgentTrees`' to stop.
   */
  stop(): Promise<ExitInfo>
}

export interface SpawnOptions {
  platform: Platform
  env: Env
  cwd: string
  onStderr(text: string): void
  onEvent?(event: string, detail?: string): void
  timings?: StopTimings
  control?: ProcessControl
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

export function spawnAgent(spec: LaunchSpec, options: SpawnOptions): SpawnedAgent {
  const { platform } = options
  const timings = options.timings ?? STOP_TIMINGS
  const { file, args, shell } = spawnArguments(spec)
  const control = options.control ?? processControl(platform)
  const child = spawn(file, args, {
    cwd: options.cwd,
    env: { ...options.env, ...spec.env } as NodeJS.ProcessEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    // Its own process group on macOS and Linux, so the whole tree can be stopped together.
    detached: platform !== 'win32',
    windowsHide: true,
    shell,
  })
  const startedAt = Date.now()
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

  // It still runs after EOF, so its tree goes as a whole, found while the links to it hold.
  const endTree = async (pid: number): Promise<void> => {
    if (platform === 'win32') {
      options.onEvent?.('taskkill')
      const ended = await control.taskkill([pid]).then(
        () => true,
        (error: unknown) => {
          options.onEvent?.('taskkill failed', (error as Error).message)
          return false
        },
      )
      // A taskkill that gave up leaves the tree to the reap that follows, which tries again.
      if (ended) await waitForExit(exited, timings.termMs)
      return
    }
    options.onEvent?.('SIGTERM')
    const terminated = await terminateTrees(control, [{ pid, startedAt }]).catch(
      (error: unknown) => {
        options.onEvent?.('process listing failed', (error as Error).message)
        return null
      },
    )
    // Without a listing, its own process group still goes.
    if (!terminated) signalGroup(control, pid, 'SIGTERM')
    if (await waitForExit(exited, timings.termMs)) return
    options.onEvent?.('SIGKILL')
    if (terminated) killSurvivors(control, terminated)
    else signalGroup(control, pid, 'SIGKILL')
    await waitForExit(exited, timings.termMs)
  }

  let stopping: Promise<ExitInfo> | null = null
  const stop = (): Promise<ExitInfo> => {
    stopping ??= (async () => {
      if (!hasExited) {
        child.stdin.end()
        if (!(await waitForExit(exited, timings.eofMs)) && child.pid) await endTree(child.pid)
      }
      return hasExited ? exited : { code: null, signal: null, error: 'did not exit after SIGKILL' }
    })()
    return stopping
  }

  return {
    pid: child.pid ?? null,
    startedAt,
    transport: processTransport(child.stdin, child.stdout),
    exited,
    get hasExited() {
      return hasExited
    },
    stop,
  }
}

function signalGroup(control: ProcessControl, pid: number, signal: NodeJS.Signals): void {
  try {
    // A negative pid addresses the process group the detached child leads.
    control.kill(-pid, signal)
  } catch {
    // Already gone.
  }
}
