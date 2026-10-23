// Process trees: everything an agent started, found in one listing of the system's processes
// and stopped together. An agent's own process group is not enough on macOS and Linux: Claude
// Code runs each command in a group of its own, and a command whose CLI is killed outlives it.
// Main imports this file too, for the agents of a host that died.

import { execFile } from 'node:child_process'
import path from 'node:path'
import type { Platform } from '@shared/platform'

export interface ProcessRow {
  pid: number
  ppid: number
  /** The process group; on Windows, which has none, the pid. */
  pgid: number
  /** Milliseconds since the epoch; from `ps`, to within a second. */
  startedAt: number
}

/** A process named by its start time as well, so a reused pid is never taken for it. */
export interface ProcessId {
  pid: number
  startedAt: number
}

export interface TreeRoot extends ProcessId {
  /**
   * When it was last known to run. Once it has exited, only what started by then can be its:
   * a process that took its pid later may have started a group or children of its own. Without
   * it, an exited root's group and children are not followed.
   */
  seenAt?: number
}

/** How far two readings of one process's start time may differ: `ps` reports whole seconds. */
export const START_SLACK_MS = 2_000

export function isProcess(row: ProcessRow, id: ProcessId): boolean {
  return row.pid === id.pid && Math.abs(row.startedAt - id.startedAt) <= START_SLACK_MS
}

/** `ps -A -o pid=,ppid=,pgid=,etime=`, where etime is `[[dd-]hh:]mm:ss`. */
export function parsePs(text: string, now: number): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(line)
    if (!match) continue
    const [, pid, ppid, pgid, days, hours, minutes, seconds] = match
    const elapsed =
      ((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60 + Number(seconds)
    rows.push({
      pid: Number(pid),
      ppid: Number(ppid),
      pgid: Number(pgid),
      startedAt: now - elapsed * 1000,
    })
  }
  return rows
}

// Windows file times count 100 ns intervals from 1601.
const FILETIME_EPOCH_MS = 11_644_473_600_000

/** The PowerShell listing below: pid, parent pid and creation time as a file time. */
export function parseCim(text: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    const fileTime = Number(match[3])
    rows.push({
      pid,
      ppid: Number(match[2]),
      pgid: pid,
      startedAt: fileTime > 0 ? Math.round(fileTime / 10_000) - FILETIME_EPOCH_MS : 0,
    })
  }
  return rows
}

// Windows has no `ps`; the processes' parents and creation times come from CIM.
const CIM_SCRIPT =
  'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | ' +
  "ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, " +
  '$(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }) }'

export interface ToolOptions {
  /** A quit waits for it, which main cuts short: it gets the quit's shorter limit. */
  quitting?: boolean
}

/** What a quit aborts a tool's run with, so that the run's stop gets the quit's limits too. */
export const QUIT_REASON = new Error('OverBench is quitting')

export interface ProcessControl {
  platform: Platform
  list(options?: ToolOptions): Promise<ProcessRow[]>
  /** `process.kill`: a negative target addresses a process group; throws `ESRCH` once it is gone. */
  kill(target: number, signal: NodeJS.Signals | 0): void
  /**
   * `taskkill /T /F` for each pid; one that is already gone is not an error, but a run that
   * timed out is, since what it was ending may still run.
   */
  taskkill(pids: number[], options?: ToolOptions): Promise<void>
  delay(ms: number): Promise<void>
}

/** How long one run of each tool may take before it is killed and its call fails. */
export interface ToolLimits {
  /** A listing: `ps`, or the CIM query through PowerShell on Windows. */
  listMs: number
  taskkillMs: number
  quitListMs: number
  quitTaskkillMs: number
}

/**
 * Long enough for a slow machine, except while quitting, which main cuts short 6 s after
 * `host:shutdown`: docs/design/agent-host.md has the sum.
 */
export function toolLimits(platform: Platform): ToolLimits {
  return {
    listMs: 10_000,
    taskkillMs: 10_000,
    // The CIM query takes 250 to 450 ms on CI, `ps` 10 to 50 ms.
    quitListMs: platform === 'win32' ? 1_500 : 1_000,
    quitTaskkillMs: 500,
  }
}

/** Runs a tool to its end. Past `timeoutMs` it is killed, and the run fails with `ETIMEDOUT`. */
export function runTool(
  file: string,
  args: string[],
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        ...(env ? { env } : {}),
      },
      (error, stdout) => {
        if (!error) resolve(stdout)
        // `killed` is set only when execFile itself killed it, which here is the timeout.
        else if (error.killed) reject(toolTimedOut(file, timeoutMs))
        else reject(error)
      },
    )
  })
}

function toolTimedOut(file: string, timeoutMs: number): NodeJS.ErrnoException {
  const name = path.win32.basename(file)
  return Object.assign(new Error(`${name} did not finish within ${timeoutMs} ms`), {
    code: 'ETIMEDOUT',
  })
}

export interface ProcessControlOptions {
  limits?: ToolLimits
  /** Runs the tools; `runTool` by default. */
  run?: typeof runTool
}

export function processControl(
  platform: Platform,
  { limits = toolLimits(platform), run = runTool }: ProcessControlOptions = {},
): ProcessControl {
  return {
    platform,
    async list({ quitting = false } = {}) {
      const limitMs = quitting ? limits.quitListMs : limits.listMs
      if (platform !== 'win32') {
        const text = await run('ps', ['-A', '-o', 'pid=,ppid=,pgid=,etime='], limitMs, {
          ...process.env,
          LC_ALL: 'C',
        })
        return parsePs(text, Date.now())
      }
      const root = process.env.SystemRoot
      const powershell = root
        ? path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        : 'powershell.exe'
      const encoded = Buffer.from(CIM_SCRIPT, 'utf16le').toString('base64')
      const text = await run(
        powershell,
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        limitMs,
      )
      return parseCim(text)
    },
    kill: (target, signal) => process.kill(target, signal),
    async taskkill(pids, { quitting = false } = {}) {
      const limitMs = quitting ? limits.quitTaskkillMs : limits.taskkillMs
      // taskkill takes many /PID arguments; a long list is split to stay well under the command line limit.
      for (let i = 0; i < pids.length; i += 64) {
        const args = ['/T', '/F', ...pids.slice(i, i + 64).flatMap((pid) => ['/PID', String(pid)])]
        // It exits with an error for a pid that is already gone.
        await run('taskkill', args, limitMs).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ETIMEDOUT') throw error
        })
      }
    },
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }
}

/**
 * The processes in the tree of `root`, the root included while it runs. On macOS and Linux that
 * is its process group, whose members keep it after the root exits, and everything descended
 * from the group. On Windows, which reparents nothing, it is everything descended from the root,
 * whose children keep its pid as their parent after it exits. Start times tell a reused pid
 * apart: a child never starts before its parent, and after the root exits only what started
 * while it ran (`seenAt`) is followed.
 */
export function treeOf(rows: ProcessRow[], root: TreeRoot, platform: Platform): ProcessRow[] {
  const children = new Map<number, ProcessRow[]>()
  for (const row of rows) {
    const list = children.get(row.ppid)
    if (list) list.push(row)
    else children.set(row.ppid, [row])
  }
  const holder = rows.find((row) => row.pid === root.pid)
  const rootRuns = holder !== undefined && isProcess(holder, root)
  const earliest = root.startedAt - START_SLACK_MS
  const latest = rootRuns ? Infinity : (root.seenAt ?? -Infinity) + START_SLACK_MS
  const ran = (row: ProcessRow): boolean => row.startedAt >= earliest && row.startedAt <= latest
  const members = new Map<number, ProcessRow>()
  const queue: ProcessRow[] = []
  const add = (row: ProcessRow): void => {
    if (row.pid <= 1 || row.pid === process.pid || members.has(row.pid)) return
    members.set(row.pid, row)
    queue.push(row)
  }
  if (rootRuns) add(holder)
  // Once another process holds the root's pid, the group id may be that process's.
  if (platform !== 'win32' && (rootRuns || holder === undefined)) {
    for (const row of rows) if (row.pgid === root.pid && ran(row)) add(row)
  }
  if (platform === 'win32' && !rootRuns) {
    for (const child of children.get(root.pid) ?? []) {
      if (ran(child) && !(holder && child.startedAt >= holder.startedAt)) add(child)
    }
  }
  for (let i = 0; i < queue.length; i++) {
    const parent = queue[i]!
    for (const child of children.get(parent.pid) ?? []) {
      if (child.startedAt >= parent.startedAt - START_SLACK_MS) add(child)
    }
  }
  return [...members.values()]
}

/**
 * The processes started under `pid`, by parent links alone, for a child that shares its parent's
 * process group. A process that started before its listed parent took a reused pid, so it is not
 * followed.
 */
export function descendantsOf(rows: ProcessRow[], pid: number): ProcessRow[] {
  const root = rows.find((row) => row.pid === pid)
  if (!root) return []
  const found = new Set<ProcessRow>()
  const queue = [root]
  for (let parent = queue.shift(); parent; parent = queue.shift()) {
    for (const row of rows) {
      if (row.ppid !== parent.pid || row === root || found.has(row)) continue
      if (row.startedAt < parent.startedAt - START_SLACK_MS) continue
      found.add(row)
      queue.push(row)
    }
  }
  return [...found]
}

/**
 * Where to send a signal on macOS and Linux: each group a root or a member leads, which reaches
 * processes started after the listing too, and a member of a group outside the trees alone.
 * Negative targets are groups.
 */
export function signalTargets(members: ProcessRow[], leaders: ReadonlySet<number>): number[] {
  const targets = new Set<number>()
  for (const row of members) {
    targets.add(row.pgid > 1 && leaders.has(row.pgid) ? -row.pgid : row.pid)
  }
  return [...targets]
}

export interface StopFailure {
  target: number
  error: string
}

export interface Terminated {
  /** Everything in the trees, once each. */
  members: ProcessRow[]
  /** The roots and the members: the groups they lead are the trees'. */
  leaders: ReadonlySet<number>
  failures: StopFailure[]
}

function signalAll(
  control: ProcessControl,
  targets: number[],
  signal: NodeJS.Signals,
  failures: StopFailure[],
): void {
  for (const target of targets) {
    try {
      control.kill(target, signal)
    } catch (error) {
      // ESRCH: already gone, which is the outcome wanted.
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        failures.push({ target, error: (error as Error).message })
      }
    }
  }
}

/**
 * Asks the trees of `roots` to stop: `SIGTERM` on macOS and Linux, and on Windows, which has no
 * signals, `taskkill /T /F`, which ends them at once.
 */
export async function terminateTrees(
  control: ProcessControl,
  roots: TreeRoot[],
  tools?: ToolOptions,
): Promise<Terminated> {
  const rows = await control.list(tools)
  const members = new Map<number, ProcessRow>()
  for (const root of roots) {
    for (const row of treeOf(rows, root, control.platform)) members.set(row.pid, row)
  }
  const leaders = new Set([...roots.map((root) => root.pid), ...members.keys()])
  const terminated: Terminated = { members: [...members.values()], leaders, failures: [] }
  if (members.size === 0) return terminated
  if (control.platform === 'win32') await control.taskkill([...members.keys()], tools)
  else
    signalAll(control, signalTargets(terminated.members, leaders), 'SIGTERM', terminated.failures)
  return terminated
}

function alive(control: ProcessControl, pid: number): boolean {
  try {
    control.kill(pid, 0)
    return true
  } catch {
    // ESRCH: gone. EPERM: the pid now belongs to a process of someone else, so not to the tree.
    return false
  }
}

/** `SIGKILL` to the members of terminated trees that are still there; Windows has none left. */
export function killSurvivors(control: ProcessControl, terminated: Terminated): StopFailure[] {
  const failures: StopFailure[] = []
  if (control.platform === 'win32') return failures
  const survivors = terminated.members.filter((row) => alive(control, row.pid))
  signalAll(control, signalTargets(survivors, terminated.leaders), 'SIGKILL', failures)
  return failures
}

/** Stops the trees of `roots`: `SIGTERM`, then `SIGKILL` to what is left after `graceMs`. */
export async function stopTrees(
  control: ProcessControl,
  roots: TreeRoot[],
  graceMs: number,
): Promise<Terminated> {
  const terminated = await terminateTrees(control, roots)
  if (control.platform === 'win32' || terminated.members.length === 0) return terminated
  await control.delay(graceMs)
  terminated.failures.push(...killSurvivors(control, terminated))
  return terminated
}
