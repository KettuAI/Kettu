// The processes the host started for agents, and what they left behind, kept in
// `state/agent-processes.json` until they are seen gone, so the next host stops what this one
// could not: after a crash of the host or of the whole app, or a quit that did not wait.

import {
  killSurvivors,
  terminateTrees,
  treeOf,
  type ProcessControl,
  type ProcessId,
  type StopFailure,
  type ToolOptions,
  type TreeRoot,
} from './process-tree'
import type { AgentProcessesFile, JsonFile, LogFn } from './storage'

export interface AgentTreesOptions {
  file: JsonFile<AgentProcessesFile>
  control: ProcessControl
  /** How long what is left gets between `SIGTERM` and `SIGKILL`. */
  graceMs: number
  /** How long after an agent's traffic its tree is listed again, at most once in that time. */
  noteMs?: number
  /** How long `close` waits for the stops in progress; what they have not done is the next host's. */
  closeWaitMs?: number
  log: LogFn
}

// Main kills the host 6 s after `host:shutdown`, and the stops before `close` can take a listing,
// the 2 s EOF wait and a taskkill: the longest quit adds up to 5.25 s.
const CLOSE_WAIT_MS = 1_250

interface Running {
  root: TreeRoot
  /** What its tree held when last listed. */
  members: TreeRoot[]
  timer: ReturnType<typeof setTimeout> | null
}

const keyOf = (id: ProcessId): string => `${id.pid}:${id.startedAt}`

export class AgentTrees {
  private readonly running = new Map<string, Running>()
  /** Processes asked to stop, kept until the grace ends; the last run's until they are asked. */
  private readonly stopping = new Set<TreeRoot[]>()
  private leftovers: TreeRoot[] = []
  private readonly reaping = new Map<string, Promise<void>>()
  private leftoverStop: Promise<void> = Promise.resolve()
  private listingFailed = false
  private closed = false

  constructor(private readonly options: AgentTreesOptions) {}

  /** Reads what the last host left; `stopLeftovers` stops it. */
  async load(): Promise<void> {
    this.leftovers = (await this.options.file.load()).processes
    if (this.leftovers.length > 0) this.stopping.add(this.leftovers)
  }

  launched(root: ProcessId): void {
    this.running.set(keyOf(root), {
      root: { ...root, seenAt: Date.now() },
      members: [],
      timer: null,
    })
    this.save()
  }

  /**
   * The agent talked: whatever it started meanwhile is listed a while later. Only a listing taken
   * while it runs finds, after a crash, a process it started in a group of its own on macOS and
   * Linux, which is reparented once it exits, or on Windows a process that a child of it started
   * detached: Node puts a child it starts without `detached` in a job object that ends with it, so
   * that child ends with the agent and nothing links the agent to what the child started.
   */
  active(root: ProcessId): void {
    const running = this.running.get(keyOf(root))
    if (!running || running.timer) return
    running.timer = setTimeout(() => {
      running.timer = null
      void this.note(root)
    }, this.options.noteMs ?? 10_000)
    running.timer.unref?.()
  }

  /** Lists the agent's tree now: after it talked, and before it is stopped. */
  async note(root: ProcessId, tools?: ToolOptions): Promise<void> {
    const { control, log } = this.options
    if (!this.running.has(keyOf(root))) return
    let rows
    try {
      rows = await control.list(tools)
    } catch (error) {
      // Once: without `ps` every listing fails alike.
      if (!this.listingFailed)
        log('warn', `Could not list the processes: ${(error as Error).message}`)
      this.listingFailed = true
      return
    }
    const running = this.running.get(keyOf(root))
    if (!running) return
    const seenAt = Date.now()
    const members = treeOf(rows, root, control.platform)
      .filter((row) => row.pid !== root.pid)
      .map(({ pid, startedAt }) => ({ pid, startedAt, seenAt }))
    const known = new Set(running.members.map((member) => member.pid))
    const changed =
      members.length !== known.size || members.some((member) => !known.has(member.pid))
    // Written only when the tree changed: an older `seenAt` only follows less of a dead root.
    running.root = { ...running.root, seenAt }
    running.members = members
    if (changed) this.save()
  }

  /**
   * Stops what is left of an agent's tree once its process has exited: `SIGTERM` now, and
   * `SIGKILL` after the grace in the background. Resolves when what is left has been asked to
   * stop and noted, so a host that exits then leaves the rest to the next. On Windows each
   * listing starts PowerShell, and the record already holds what the next host needs to find the
   * rest, the root and what was noted: it resolves at once, and `close` waits for the rest.
   */
  reap(root: ProcessId, name: string, tools?: ToolOptions): Promise<void> {
    const key = keyOf(root)
    let run = this.reaping.get(key)
    if (!run) {
      const running = this.running.get(key)
      this.running.delete(key)
      if (running?.timer) clearTimeout(running.timer)
      // It has just exited, and what is noted ran until a moment ago at the latest.
      const seenAt = Date.now()
      const noted = [root, ...(running?.members ?? [])].map((id) => ({ ...id, seenAt }))
      // On Windows only `close` waits for it, and only up to its deadline: no quit limit.
      const windows = this.options.control.platform === 'win32'
      run = this.stopNoted(noted, `${name} left behind`, windows ? {} : tools)
        .catch((error: unknown) => {
          this.options.log('warn', `Could not stop what ${name} left: ${(error as Error).message}`)
        })
        .finally(() => this.reaping.delete(key))
      this.reaping.set(key, run)
    }
    return this.options.control.platform === 'win32' ? Promise.resolve() : run
  }

  /** Stops what the last host left behind, as `reap` does. */
  async stopLeftovers(): Promise<void> {
    const leftovers = this.leftovers
    this.leftovers = []
    if (leftovers.length === 0) return
    this.stopping.delete(leftovers)
    this.leftoverStop = this.stopNoted(leftovers, 'the last run left').catch((error: unknown) => {
      this.options.log('warn', `Could not stop what the last run left: ${(error as Error).message}`)
    })
    await this.leftoverStop
  }

  /**
   * Asks the trees of `noted` to stop, keeping them in the file, with what the trees hold, until
   * the grace ends and `SIGKILL` has gone to what is left. When the listing or taskkill fails they
   * stay, for the next host.
   */
  private async stopNoted(noted: TreeRoot[], what: string, tools?: ToolOptions): Promise<void> {
    const { control, graceMs, log } = this.options
    this.stopping.add(noted)
    this.save()
    const terminated = await terminateTrees(control, noted, tools)
    this.logFailures(what, terminated.failures)
    const { members } = terminated
    this.stopping.delete(noted)
    if (members.length === 0 || control.platform === 'win32') {
      if (members.length > 0) log('info', `Stopped ${members.length} process(es) ${what}`)
      this.save()
      return
    }
    log('info', `Stopping ${members.length} process(es) ${what}`)
    const seenAt = Date.now()
    const held = [...noted, ...members.map(({ pid, startedAt }) => ({ pid, startedAt, seenAt }))]
    this.stopping.add(held)
    this.save()
    void control.delay(graceMs).then(() => {
      this.logFailures(what, killSurvivors(control, terminated))
      this.stopping.delete(held)
      this.save()
    })
  }

  flush(): Promise<void> {
    return this.options.file.flush()
  }

  /**
   * Waits for the stops in progress, up to `closeWaitMs`, writes the record, and writes nothing
   * after: the host exits next, and a later write could land as it does. What is still in its
   * grace, or was still being listed, stays recorded for the next host.
   */
  async close(): Promise<void> {
    const waitMs = this.options.closeWaitMs ?? CLOSE_WAIT_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<boolean>(
      (resolve) => (timer = setTimeout(() => resolve(true), waitMs)),
    )
    const stops = Promise.all([...this.reaping.values(), this.leftoverStop]).then(() => false)
    const timedOut = await Promise.race([stops, late])
    clearTimeout(timer)
    this.closed = true
    if (timedOut) {
      this.options.log(
        'warn',
        `Stopped waiting for what the agents left after ${waitMs} ms; the next run stops it`,
      )
    }
    await this.options.file.flush()
  }

  private save(): void {
    if (this.closed) return
    const processes = new Map<string, TreeRoot>()
    for (const { root, members } of this.running.values()) {
      for (const id of [root, ...members]) processes.set(keyOf(id), id)
    }
    for (const ids of this.stopping) for (const id of ids) processes.set(keyOf(id), id)
    this.options.file.save({ version: 1, processes: [...processes.values()] })
  }

  private logFailures(what: string, failures: StopFailure[]): void {
    for (const { target, error } of failures) {
      this.options.log('warn', `Could not stop ${target} of what ${what}: ${error}`)
    }
  }
}
