// Spawning and stopping one agent process, by each platform's rules.

import { spawn, type ChildProcess } from 'node:child_process'
import type { Platform } from '@shared/platform'
import type { LaunchSpec } from './catalog'
import type { StdioTransport } from './driver'
import type { Env } from './find-command'
import {
  killSurvivors,
  processControl,
  terminateTrees,
  type ProcessControl,
  type Terminated,
  type ToolOptions,
} from './process-tree'
import { quoteCmd } from './quote'

export interface ExitInfo {
  code: number | null
  signal: string | null
  /** Set when the process could not be started at all, or when a stop did not end it. */
  error?: string
}

export interface StopTimings {
  /** How long an agent gets to exit after its stdin closes. */
  eofMs: number
  /** How long after SIGTERM before SIGKILL, on macOS and Linux. */
  termMs: number
}

export const STOP_TIMINGS: StopTimings = { eofMs: 2_000, termMs: 3_000 }

// How long a quit's kill waits for the exit, so that the reap of what is left starts before the
// record's last write: the longest quit adds up to 5.25 s of the 6 s main allows.
const KILL_WAIT_MS = 500

/** What runs for a started agent and a stop ends: its process, or what it spawned. */
export interface AgentRun {
  /** Null for a run with no process of its own. */
  readonly pid: number | null
  /** When it was spawned, which names it apart from a later process with its pid. */
  readonly startedAt: number
  readonly exited: Promise<ExitInfo>
  readonly hasExited: boolean
  /**
   * EOF; then, if it still runs, SIGTERM to its whole process tree and SIGKILL to what is left,
   * or `taskkill /T /F` on Windows. What it leaves behind once it exits is `AgentTrees`' to stop.
   * When it still runs at the end, the result's `error` names the step that failed.
   */
  stop(tools?: ToolOptions): Promise<ExitInfo>
  /**
   * Ends it now, for a quit that cannot wait for `stop` any longer, wherever the stop has got to:
   * `SIGKILL` to the groups its stop listed, else to its own, or `taskkill /T /F` with the quit's
   * limit on Windows. Resolves once it has exited, or after KILL_WAIT_MS.
   */
  kill(): Promise<void>
}

export interface SpawnedAgent extends AgentRun {
  readonly transport: StdioTransport
  readonly child: ChildProcess
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

  let terminated: Terminated | null = null
  // What a stop that did not end the agent reports: the last step it took, or the one that failed.
  let failure = 'did not exit after SIGKILL'
  // It still runs after EOF, so its tree goes as a whole, found while the links to it hold.
  const endTree = async (pid: number, tools: ToolOptions): Promise<void> => {
    if (platform === 'win32') {
      options.onEvent?.('taskkill')
      const ended = await control.taskkill([pid], tools).then(
        () => true,
        (error: unknown) => {
          options.onEvent?.('taskkill failed', (error as Error).message)
          failure = `taskkill failed: ${(error as Error).message}`
          return false
        },
      )
      if (ended) failure = 'did not exit after taskkill'
      // A quit leaves what a taskkill that gave up was ending to the reap, which tries again.
      if (ended || !tools.quitting) await waitForExit(exited, timings.termMs)
      return
    }
    options.onEvent?.('SIGTERM')
    terminated = await terminateTrees(control, [{ pid, startedAt }], tools).catch(
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
  const stop = (tools: ToolOptions = {}): Promise<ExitInfo> => {
    stopping ??= (async () => {
      if (!hasExited) {
        child.stdin.end()
        if (!(await waitForExit(exited, timings.eofMs)) && child.pid)
          await endTree(child.pid, tools)
      }
      return hasExited ? exited : { code: null, signal: null, error: failure }
    })()
    return stopping
  }

  const kill = async (): Promise<void> => {
    if (hasExited || !child.pid) return
    if (platform === 'win32') {
      options.onEvent?.('taskkill')
      void control.taskkill([child.pid], { quitting: true }).catch((error: unknown) => {
        options.onEvent?.('taskkill failed', (error as Error).message)
      })
    } else {
      options.onEvent?.('SIGKILL')
      if (terminated) killSurvivors(control, terminated)
      else signalGroup(control, child.pid, 'SIGKILL')
    }
    await waitForExit(exited, KILL_WAIT_MS)
  }

  return {
    pid: child.pid ?? null,
    startedAt,
    transport: { kind: 'stdio', stdin: child.stdin, stdout: child.stdout },
    child,
    exited,
    get hasExited() {
      return hasExited
    },
    stop,
    kill,
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
