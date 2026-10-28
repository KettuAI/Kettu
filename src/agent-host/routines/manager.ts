// The routines: their JSON file, the runs they record, and the lifecycle of each run.

import { randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { PlanLimit, RoutineList, SessionSummary } from '@shared/agent-host'
import { markdownFirstLine } from '@shared/markdown-line'
import { nextRuns } from '@shared/schedule'
import {
  KEPT_RUN_SESSIONS,
  RUN_OUTPUT_BYTES,
  RUNS_PAGE,
  ROUTINE_NAME_CHARS,
  ROUTINE_NAME_FROM_PROMPT,
  WORKING_RUNS,
  type PermissionScope,
  type Routine,
  type RoutineChanges,
  type RoutineDraft,
  type RoutineRef,
  type RoutineRun,
  type RoutineView,
  type RoutinesProblem,
  type RunPage,
  type RunStatus,
  type RunView,
} from '@shared/routines'
import type { AgentId } from '@shared/thread'
import { HostError } from '../errors'
import { currentLocale, hasMessage, t } from '../i18n'
import type { JsonFile, LogFn, RoutinesFile } from '../storage'
import type { ThreadStore } from '../threads/store'
import type { RoutineCallName, RoutineCalls, RoutineRunStats } from './calls'
import type { RoutineSessionHooks, RoutineSessions, RunTurnResult } from './hooks'
import {
  LIMITS_FRESH_MS,
  RoutineScheduler,
  SYSTEM_CLOCK,
  type LimitPause,
  type PauseChange,
  type RoutineClock,
  type SchedulerRoutine,
} from './scheduler'

export interface RoutineTimings {
  /** How long a minute of a run's time limit lasts; a minute, shortened by tests. */
  minuteMs: number
}

export const ROUTINE_TIMINGS: RoutineTimings = { minuteMs: 60_000 }

export interface RoutineEvents {
  /** A routine, its state or its next run changed. */
  changed(routine: RoutineView): void
  removed(routineId: string): void
  /** A run's status changed. */
  run(run: RoutineRun): void
  /** Whether any run is starting or running changed. */
  working(working: boolean): void
  attention(
    kind: 'routine-ended' | 'error' | 'permission',
    sessionId: string,
    title: string,
    body: string,
  ): void
  /** An agent's routines paused at a plan limit, announced once per pause. */
  paused(agentId: AgentId, title: string, body: string): void
}

/** What the routines need of the agents: their plan limits and their names. */
export interface RoutineAgents {
  /** The plan limits the agent reported last. */
  limits(agentId: AgentId): readonly PlanLimit[]
  /** Reads the agent's plan limits again from its own report; nothing for an agent without one. */
  readLimits(agentId: AgentId): Promise<void>
  name(agentId: AgentId): string
}

export interface RoutinesDeps {
  userDataPath: string
  file: JsonFile<RoutinesFile>
  threads: ThreadStore | null
  sessions: RoutineSessions
  agents: RoutineAgents
  log: LogFn
  events: RoutineEvents
  /** A project folder, canonical; rejects when it is missing. */
  resolveProject(path: string): Promise<string>
  now?: () => number
  /** The scheduler's clock and timer; the system's by default, or a test's. */
  clock?: RoutineClock
  timings?: Partial<RoutineTimings>
}

/** A run in flight: its record, the clock of its time limit, and how it is being stopped. */
interface LiveRun {
  run: RoutineRun
  workingSince: number | null
  timer: ReturnType<typeof setTimeout> | null
  intent: 'timed_out' | 'cancelled' | null
}

type RunEnd = {
  stopReason?: RoutineRun['stopReason']
  error?: RoutineRun['error']
  output?: string | null
  usage?: RoutineRun['usage']
  changedFiles?: string[]
}

export class RoutinesManager {
  private readonly routines = new Map<string, Routine>()
  /** The runs that are queued, starting, running or waiting. */
  private readonly runs = new Map<string, LiveRun>()
  private readonly bySession = new Map<string, string>()
  private readonly queued: string[] = []
  private readonly lastViews = new Map<string, string>()
  /** The latest skipped run of each routine, while skips stay consecutive. */
  private readonly lastSkips = new Map<string, RoutineRun>()
  /** When the routines last read each agent's plan limits, whatever the reading found. */
  private readonly limitsRead = new Map<AgentId, number>()
  private readonly reading = new Map<AgentId, Promise<void>>()
  private readonly writes = new Set<Promise<unknown>>()
  private readonly deleting = new Set<string>()
  private readonly clock: RoutineClock
  private readonly scheduler: RoutineScheduler
  private readonly now: () => number
  private readonly timings: RoutineTimings
  private problem: RoutinesProblem | null = null
  private loaded = false
  private stopped = false
  private working = false

  constructor(private readonly deps: RoutinesDeps) {
    this.clock = deps.clock ?? { ...SYSTEM_CLOCK, now: deps.now ?? SYSTEM_CLOCK.now }
    this.now = () => this.clock.now()
    this.timings = { ...ROUTINE_TIMINGS, ...deps.timings }
    this.scheduler = new RoutineScheduler({
      clock: this.clock,
      routines: () => [...this.routines.values()].map(schedulerRoutine),
      due: (routineId, at, trigger, count) => this.scheduled(routineId, at, trigger, count),
      accounted: (routineId, at) => this.account(routineId, at),
      limits: (agentId) => this.deps.agents.limits(agentId),
      paused: (agentId, pause, change) => this.pauseChanged(agentId, pause, change),
    })
  }

  /** The hooks the sessions manager calls for a run's session. */
  readonly hooks: RoutineSessionHooks = {
    sessionCreated: (sessionId, routine) => this.sessionCreated(sessionId, routine),
    turnStarted: (sessionId) => this.turnStarted(sessionId),
    waiting: (sessionId, waiting, title) => this.setWaiting(sessionId, waiting, title),
    turnEnded: (sessionId, result) => this.turnEnded(sessionId, result),
    sessionGone: (sessionId) => this.sessionGone(sessionId),
  }

  async load(): Promise<void> {
    const file = await this.deps.file.load()
    for (const routine of file.routines) this.routines.set(routine.id, routine)
    if (this.deps.file.status === 'corrupt') {
      this.problem = { reason: 'corrupt', backup: this.deps.file.backupPath }
    } else if (this.deps.file.status === 'newer') {
      this.problem = { reason: 'newer', backup: null }
    }
    // A run the last host left working is interrupted, as after a crash; nothing resumes it.
    const active = await this.call('active', undefined).catch(() => [])
    const now = this.now()
    for (const run of active) {
      this.persist({ ...run, status: 'interrupted', endedAt: now, seen: false })
    }
    this.loaded = true
    this.settleOnce()
  }

  /** A one-time routine whose time is accounted for is off, even if the host stopped mid-run. */
  private settleOnce(): void {
    let changed = false
    for (const [routineId, routine] of this.routines) {
      if (!routine.enabled || routine.trigger.schedule.kind !== 'once') continue
      if (nextRuns(routine.trigger.schedule, routine.checkedThrough, { count: 1 }).length > 0) {
        continue
      }
      this.routines.set(routineId, { ...routine, enabled: false })
      changed = true
    }
    if (changed) this.save()
  }

  /** Starts the schedule timer, once the host and its sessions are loaded. */
  start(): void {
    this.scheduler.start()
  }

  /** The computer slept or woke; the timer starts over from the wall clock. */
  power(state: 'suspend' | 'resume'): void {
    this.scheduler.power(state)
  }

  /** The agent reported its status, its plan limits among it: a pause may begin, end or move. */
  limitsChanged(agentId: AgentId): void {
    if (this.scheduler.pauseOf(agentId)) {
      this.scheduler.limitsChanged(agentId)
      return
    }
    // A reading restored from the last run is refreshed before it may pause anything.
    if (this.limitsStale(agentId)) return
    const enabled = [...this.routines.values()].some(
      (routine) => routine.enabled && routine.agentId === agentId,
    )
    if (enabled) this.scheduler.check(agentId)
  }

  async list(): Promise<RoutineList> {
    if (!this.loaded) await this.load()
    const routines = [...this.routines.values()].sort((a, b) => a.createdAt - b.createdAt)
    const views = await Promise.all(routines.map((routine) => this.viewOf(routine)))
    return { routines: views, problem: this.problem }
  }

  async create(draft: RoutineDraft): Promise<RoutineView> {
    if (!this.loaded) await this.load()
    const now = this.now()
    const routine: Routine = {
      ...draft,
      id: `r-${randomBytes(6).toString('hex')}`,
      name: routineName(draft.name, draft.prompt),
      projectPath:
        draft.projectPath === null ? null : await this.deps.resolveProject(draft.projectPath),
      enabled: true,
      createdAt: now,
      updatedAt: now,
      checkedThrough: now,
    }
    this.routines.set(routine.id, routine)
    this.save()
    const view = await this.viewOf(routine)
    this.lastViews.set(routine.id, JSON.stringify(view))
    this.deps.events.changed(view)
    this.scheduler.refresh()
    return view
  }

  async update(routineId: string, changes: RoutineChanges): Promise<RoutineView> {
    if (!this.loaded) await this.load()
    const routine = this.routineOf(routineId)
    const next: Routine = { ...routine }
    if (changes.name !== undefined) {
      next.name = routineName(changes.name, changes.prompt ?? routine.prompt)
    }
    if (changes.prompt !== undefined) next.prompt = changes.prompt
    if (changes.agentId !== undefined) next.agentId = changes.agentId
    if (changes.projectPath !== undefined) {
      next.projectPath =
        changes.projectPath === null ? null : await this.deps.resolveProject(changes.projectPath)
    }
    if (changes.options !== undefined) next.options = changes.options
    if (changes.trigger !== undefined) next.trigger = changes.trigger
    if (changes.scope !== undefined) next.scope = changes.scope
    if (changes.timeLimitMinutes !== undefined) next.timeLimitMinutes = changes.timeLimitMinutes
    const turnedOn = changes.enabled === true && !routine.enabled
    if (changes.enabled !== undefined) next.enabled = changes.enabled
    // Turning on or changing the schedule never catches up the time it was off or different.
    if (turnedOn || changes.trigger !== undefined) next.checkedThrough = this.now()
    next.updatedAt = this.now()
    this.routines.set(routineId, next)
    this.save()
    const view = await this.viewOf(next)
    this.lastViews.set(routineId, JSON.stringify(view))
    this.deps.events.changed(view)
    this.scheduler.refresh()
    return view
  }

  async delete(routineId: string): Promise<void> {
    if (!this.loaded) await this.load()
    this.routineOf(routineId)
    this.deleting.add(routineId)
    try {
      const sessions: string[] = []
      let before: number | null = null
      for (;;) {
        const page: { runs: RoutineRun[]; older: number | null } = await this.call('page', {
          routineId,
          before,
          limit: RUNS_PAGE,
        })
        for (const run of page.runs) if (run.sessionId) sessions.push(run.sessionId)
        if (page.older === null) break
        before = page.older
      }
      for (const sessionId of sessions) {
        if (!this.deps.sessions.has(sessionId)) continue
        await this.deps.sessions.delete(sessionId).catch((error: unknown) => {
          this.deps.log('warn', `Could not delete the session of a run: ${messageOf(error)}`)
        })
      }
      for (const [runId, live] of [...this.runs]) {
        if (live.run.routineId !== routineId) continue
        if (live.timer) clearTimeout(live.timer)
        this.runs.delete(runId)
      }
      this.queued.splice(
        0,
        this.queued.length,
        ...this.queued.filter((runId) => this.runs.has(runId)),
      )
      await this.call('remove', { routineId })
      this.routines.delete(routineId)
      this.lastViews.delete(routineId)
      this.lastSkips.delete(routineId)
      this.save()
      this.setWorking()
      this.deps.events.removed(routineId)
      this.scheduler.refresh()
      this.startNext()
    } finally {
      this.deleting.delete(routineId)
    }
  }

  async runNow(routineId: string): Promise<RoutineRun> {
    if (!this.loaded) await this.load()
    const routine = this.routineOf(routineId)
    if (this.activeOf(routineId)) throw new HostError('busy', t('routines.busy'))
    if (this.stopped) throw new HostError('busy', t('routines.stopping'))
    const run = this.launch(routine, 'manual', null, 1)
    this.deps.log('info', `Run ${run.id} of ${routine.name}: ${run.status}`)
    return { ...run }
  }

  async cancelRun(runId: string): Promise<void> {
    const live = this.runs.get(runId)
    if (!live) throw new HostError('not_found', t('routines.noRun'))
    if (live.run.status === 'queued') {
      this.dequeue(runId)
      this.finish(live, 'cancelled', {})
      return
    }
    live.intent = 'cancelled'
    this.pauseClock(live)
    const sessionId = live.run.sessionId
    if (!sessionId) return // The start stops its session once it exists.
    await this.deps.sessions.cancel(sessionId).catch((error: unknown) => {
      this.deps.log('warn', `Could not stop the run's turn: ${messageOf(error)}`)
      this.finish(live, 'cancelled', {})
    })
  }

  async runsOf(routineId: string, before?: number): Promise<RunPage> {
    this.routineOf(routineId)
    const page = await this.call('page', { routineId, before: before ?? null, limit: RUNS_PAGE })
    const runs: RunView[] = page.runs.map((run) => ({
      ...run,
      session: run.sessionId ? this.deps.sessions.summary(run.sessionId) : null,
    }))
    return { runs, older: page.older }
  }

  async markSeen(routineId: string): Promise<void> {
    this.routineOf(routineId)
    await this.call('markSeen', { routineId })
    void this.publish(routineId)
  }

  /**
   * A scheduled time came due: run it, or record it skipped while the routine still works or
   * its agent is near a plan limit.
   */
  private scheduled(
    routineId: string,
    at: number,
    trigger: 'schedule' | 'catch-up',
    count: number,
  ): void {
    const routine = this.routines.get(routineId)
    if (!routine || !routine.enabled || this.stopped) return
    const reason = this.activeOf(routineId)
      ? 'overlap'
      : this.held(routine.agentId)
        ? 'plan_limit'
        : null
    if (reason) {
      this.skip(routine, at, count, reason)
      if (routine.trigger.schedule.kind === 'once') this.finishOnce(routineId)
      return
    }
    const run = this.launch(routine, trigger, at, count)
    this.deps.log('info', `Run ${run.id} of ${routine.name}: ${run.status} (${trigger})`)
  }

  /**
   * Whether the agent's scheduled runs wait for a plan limit: while it is paused, or when its
   * latest limits, read recently enough, find a window near and so pause it.
   */
  private held(agentId: AgentId): boolean {
    if (this.scheduler.pauseOf(agentId)) return true
    return !this.limitsStale(agentId) && this.scheduler.check(agentId) !== null
  }

  /** Whether the agent's limits were last read longer ago than a scheduled run trusts. */
  private limitsStale(agentId: AgentId): boolean {
    let read = this.limitsRead.get(agentId) ?? 0
    for (const limit of this.deps.agents.limits(agentId)) read = Math.max(read, limit.observedAt)
    return this.now() - read > LIMITS_FRESH_MS
  }

  /** Reads the agent's plan limits again, one reading at a time; a failure keeps the last ones. */
  private readLimits(agentId: AgentId): Promise<void> {
    const current = this.reading.get(agentId)
    if (current) return current
    const reading = this.deps.agents
      .readLimits(agentId)
      .catch((error: unknown) => {
        const agent = this.deps.agents.name(agentId)
        this.deps.log('warn', `Could not read the plan limits of ${agent}: ${messageOf(error)}`)
      })
      .finally(() => {
        this.reading.delete(agentId)
        this.limitsRead.set(agentId, this.now())
      })
    this.reading.set(agentId, reading)
    return reading
  }

  private pauseChanged(agentId: AgentId, pause: LimitPause | null, change: PauseChange): void {
    if (change === 'began' && pause) {
      // Queued scheduled runs of the agent would start near the limit too.
      for (const runId of [...this.queued]) {
        const live = this.runs.get(runId)
        if (!live || live.run.trigger === 'manual') continue
        if (this.routines.get(live.run.routineId)?.agentId === agentId) this.skipHeld(live)
      }
      this.announce(pause)
    }
    // Its time is up: a fresh reading lifts it, or moves it to the window that still holds.
    if (change === 'time-up') void this.readLimits(agentId)
    if (change !== 'changed') {
      const agent = this.deps.agents.name(agentId)
      this.deps.log(
        'info',
        pause
          ? `The routines of ${agent} are paused at its ${pause.limit.label} limit`
          : `The routines of ${agent} resumed`,
      )
    }
    for (const routine of this.routines.values()) {
      if (routine.agentId === agentId) void this.publish(routine.id)
    }
  }

  /** One notification per pause: the agent, the window, its use and when it resets. */
  private announce({ agentId, limit }: LimitPause): void {
    const params = {
      limit: windowName(limit),
      percent: Math.round(limit.usedPercent ?? 0),
      time: limit.resetsAt === null ? '' : resetTime(limit.resetsAt, this.now()),
    }
    const reached = limit.state === 'reached'
    const body =
      limit.resetsAt === null
        ? reached
          ? t('routines.pausedReachedNoReset', params)
          : t('routines.pausedUsedNoReset', params)
        : reached
          ? t('routines.pausedReached', params)
          : t('routines.pausedUsed', params)
    const title = t('routines.pausedTitle', { agent: this.deps.agents.name(agentId) })
    this.deps.events.paused(agentId, title, body)
  }

  /** The scheduler moved how far every scheduled time is accounted for. */
  private account(routineId: string, at: number): void {
    const routine = this.routines.get(routineId)
    if (!routine || at <= routine.checkedThrough) return
    this.routines.set(routineId, { ...routine, checkedThrough: at })
    this.save()
  }

  /** A one-time routine ran, so it turns off; its page shows it as done. */
  private finishOnce(routineId: string): void {
    const routine = this.routines.get(routineId)
    if (!routine || !routine.enabled) return
    const next: Routine = { ...routine, enabled: false, updatedAt: this.now() }
    this.routines.set(routineId, next)
    this.save()
    void this.publish(routineId)
    this.scheduler.refresh()
  }

  /** Consecutive due times skipped for one reason share one record, counted. */
  private skip(
    routine: Routine,
    at: number,
    count: number,
    reason: NonNullable<RoutineRun['reason']>,
  ): void {
    const existing = this.lastSkips.get(routine.id)
    if (existing?.reason === reason) {
      const run: RoutineRun = {
        ...existing,
        count: existing.count + count,
        endedAt: this.now(),
      }
      this.lastSkips.set(routine.id, run)
      this.persist(run)
      this.emit(run)
      void this.publish(routine.id)
      return
    }
    const run: RoutineRun = {
      id: `run-${randomBytes(6).toString('hex')}`,
      routineId: routine.id,
      trigger: 'schedule',
      scheduledFor: at,
      count,
      status: 'skipped',
      reason,
      sessionId: null,
      startedAt: null,
      endedAt: this.now(),
      workingMs: 0,
      stopReason: null,
      error: null,
      output: null,
      usage: null,
      changedFiles: [],
      seen: false,
    }
    this.lastSkips.set(routine.id, run)
    this.persist(run)
    this.emit(run)
    void this.publish(routine.id)
  }

  /** Starts a run for a routine, queued beyond the runs that may work at once. */
  private launch(
    routine: Routine,
    trigger: RoutineRun['trigger'],
    scheduledFor: number | null,
    count: number,
  ): RoutineRun {
    const working = this.workingCount()
    const run: RoutineRun = {
      id: `run-${randomBytes(6).toString('hex')}`,
      routineId: routine.id,
      trigger,
      scheduledFor,
      count,
      status: working >= WORKING_RUNS ? 'queued' : 'starting',
      reason: null,
      sessionId: null,
      startedAt: null,
      endedAt: null,
      workingMs: 0,
      stopReason: null,
      error: null,
      output: null,
      usage: null,
      changedFiles: [],
      seen: false,
    }
    const live: LiveRun = { run, workingSince: null, timer: null, intent: null }
    this.runs.set(run.id, live)
    // A real run breaks the run of skipped times.
    this.lastSkips.delete(routine.id)
    this.persist(run)
    this.emit(run)
    void this.publish(routine.id)
    if (run.status === 'queued') this.queued.push(run.id)
    else void this.begin(live)
    return run
  }

  private activeOf(routineId: string): boolean {
    for (const live of this.runs.values()) {
      if (live.run.routineId === routineId) return true
    }
    return false
  }

  /** A run's session was created: the run names it from now on. */
  private sessionCreated(sessionId: string, routine: RoutineRef): void {
    const live = this.runs.get(routine.runId)
    if (!live) return
    this.bySession.set(sessionId, routine.runId)
    if (live.run.sessionId === sessionId) return
    live.run.sessionId = sessionId
    this.persist(live.run)
    this.emit(live.run)
    void this.publish(live.run.routineId)
  }

  private turnStarted(sessionId: string): void {
    const live = this.liveOfSession(sessionId)
    if (!live || live.run.status === 'waiting' || this.deleting.has(live.run.routineId)) return
    live.run.status = 'running'
    live.run.startedAt ??= this.now()
    this.resumeClock(live)
    this.persist(live.run)
    this.emit(live.run)
    void this.publish(live.run.routineId)
    this.setWorking()
  }

  private setWaiting(sessionId: string, waiting: boolean, title?: string): void {
    const live = this.liveOfSession(sessionId)
    if (!live || this.deleting.has(live.run.routineId)) return
    if (waiting) {
      if (live.run.status !== 'running' && live.run.status !== 'starting') return
      this.pauseClock(live)
      live.run.status = 'waiting'
      this.persist(live.run)
      this.emit(live.run)
      void this.publish(live.run.routineId)
      this.setWorking()
      if (live.run.sessionId) {
        this.deps.events.attention(
          'permission',
          live.run.sessionId,
          t('routines.needsApproval', { name: this.nameOf(live.run.routineId) }),
          title ?? t('attention.permission'),
        )
      }
      return
    }
    if (live.run.status !== 'waiting') return
    live.run.status = 'running'
    this.resumeClock(live)
    this.persist(live.run)
    this.emit(live.run)
    void this.publish(live.run.routineId)
    this.setWorking()
  }

  private turnEnded(sessionId: string, result: RunTurnResult): void {
    const live = this.liveOfSession(sessionId)
    if (!live || this.deleting.has(live.run.routineId)) return
    const status: RunStatus =
      live.intent === 'timed_out'
        ? 'timed_out'
        : result.error
          ? 'failed'
          : result.stopReason === 'end_turn'
            ? 'succeeded'
            : result.stopReason === 'cancelled'
              ? 'cancelled'
              : 'failed'
    this.finish(live, status, {
      stopReason: result.stopReason,
      error: result.error,
      output: result.output,
      usage: result.usage,
      changedFiles: result.changedFiles,
    })
  }

  private sessionGone(sessionId: string): void {
    const runId = this.bySession.get(sessionId)
    this.bySession.delete(sessionId)
    const live = runId ? this.runs.get(runId) : undefined
    if (live) {
      if (this.deleting.has(live.run.routineId)) {
        this.runs.delete(live.run.id)
      } else {
        // Its session went while the run was active: nothing is left to watch.
        live.run.sessionId = null
        this.finish(live, 'interrupted', {})
      }
    }
    // Runs that already ended keep their records, without the session that went.
    void this.call('clearSession', { sessionId })
      .then((cleared) => {
        for (const run of cleared) {
          this.emit(run)
          void this.publish(run.routineId)
        }
      })
      .catch((error: unknown) => {
        this.deps.log('warn', `Could not clear the run's session: ${messageOf(error)}`)
      })
  }

  /** Marks every working run interrupted and flushes the records; the host is stopping. */
  async shutdown(): Promise<void> {
    this.stopped = true
    this.scheduler.stop()
    for (const live of this.runs.values()) {
      this.pauseClock(live)
      if (live.timer) clearTimeout(live.timer)
      live.timer = null
      const next: RoutineRun = {
        ...live.run,
        status: 'interrupted',
        endedAt: this.now(),
        seen: false,
      }
      this.persist(next)
      this.emit(next)
    }
    this.runs.clear()
    this.bySession.clear()
    this.queued.length = 0
    this.deps.file.save({ version: 1, routines: [...this.routines.values()] })
    this.setWorking()
    await Promise.allSettled([...this.writes, this.deps.file.flush()])
  }

  private async begin(live: LiveRun): Promise<void> {
    const routine = this.routines.get(live.run.routineId)
    if (!routine || this.stopped) return
    // Run now starts outside a plan-limit pause, since the user asked for it.
    const scheduled = live.run.trigger !== 'manual'
    if (scheduled && this.held(routine.agentId)) {
      this.skipHeld(live)
      return
    }
    live.run.status = 'starting'
    live.run.startedAt = this.now()
    live.run.workingMs = 0
    this.persist(live.run)
    this.emit(live.run)
    void this.publish(routine.id)
    this.setWorking()
    if (scheduled && this.limitsStale(routine.agentId)) {
      await this.readLimits(routine.agentId)
      if (this.runs.get(live.run.id) !== live || this.stopped) return
      if (live.intent) {
        this.finish(live, 'cancelled', {})
        return
      }
      if (this.scheduler.check(routine.agentId)) {
        this.skipHeld(live)
        return
      }
    }
    let summary: SessionSummary
    try {
      const folder = routine.projectPath ?? (await this.routineFolder(routine.id))
      summary = await this.deps.sessions.createRun({
        agentId: routine.agentId,
        projectPath: folder,
        options: Object.fromEntries(routine.options.map((option) => [option.id, option.value])),
        prompt: routine.prompt,
        routine: {
          routineId: routine.id,
          runId: live.run.id,
          trigger: live.run.trigger,
          scheduledFor: live.run.scheduledFor,
        },
        scope: routine.scope,
        mode: askingMode(routine.agentId, routine.scope.level),
      })
    } catch (error) {
      this.deps.log('warn', `The run of ${routine.name} could not start: ${messageOf(error)}`)
      this.finish(live, 'failed', { error: { message: messageOf(error) } })
      return
    }
    const current = this.runs.get(live.run.id)
    if (!current) {
      // The routine went while its session started: the session goes with it. A run that ended
      // by itself keeps its session, which stays in the session index.
      if (!this.routines.has(routine.id)) {
        void this.deps.sessions.delete(summary.id).catch(() => {})
      }
      return
    }
    if (current.run.status === 'starting') {
      current.run.status = 'running'
      this.resumeClock(current)
    }
    this.persist(current.run)
    this.emit(current.run)
    void this.publish(routine.id)
    this.setWorking()
    this.deps.log('info', `Run ${current.run.id} of ${routine.name}: ${current.run.status}`)
    void this.trim(routine)
    if (current.intent && current.run.sessionId) {
      await this.deps.sessions.cancel(current.run.sessionId).catch(() => {})
    }
  }

  /** Keeps the sessions of the routine's latest 100 runs, as deleted sessions are removed. */
  private async trim(routine: Routine): Promise<void> {
    try {
      const beyond = await this.call('beyond', {
        routineId: routine.id,
        keep: KEPT_RUN_SESSIONS,
      })
      for (const { sessionId } of beyond) {
        if (!this.deps.sessions.has(sessionId)) {
          await this.call('clearSession', { sessionId }).catch(() => {})
          continue
        }
        try {
          await this.deps.sessions.delete(sessionId)
        } catch (error) {
          this.deps.log(
            'warn',
            `Could not remove an old session of ${routine.name}: ${messageOf(error)}`,
          )
        }
      }
      void this.publish(routine.id)
    } catch (error) {
      // The thread store may be closing, as at quit; the next run trims again.
      this.deps.log('warn', `Could not trim the runs of ${routine.name}: ${messageOf(error)}`)
    }
  }

  private finish(live: LiveRun, status: RunStatus, result: RunEnd): void {
    this.pauseClock(live)
    if (live.timer) clearTimeout(live.timer)
    live.timer = null
    const run: RoutineRun = {
      ...live.run,
      status,
      endedAt: this.now(),
      stopReason: result.stopReason ?? null,
      error: result.error ?? null,
      output: cutOutput(result.output ?? null),
      usage: result.usage ?? null,
      changedFiles: result.changedFiles ?? [],
      seen: false,
    }
    this.dequeue(run.id)
    this.runs.delete(run.id)
    if (run.sessionId && this.bySession.get(run.sessionId) === run.id) {
      this.bySession.delete(run.sessionId)
    }
    this.persist(run)
    this.emit(run)
    void this.publish(run.routineId)
    this.setWorking()
    this.notify(run)
    if (run.trigger !== 'manual') {
      const routine = this.routines.get(run.routineId)
      if (routine?.trigger.schedule.kind === 'once') this.finishOnce(run.routineId)
    }
    this.startNext()
  }

  /** A scheduled run that has not started waits for a plan limit: its record becomes the skip. */
  private skipHeld(live: LiveRun): void {
    if (this.runs.get(live.run.id) !== live) return
    this.pauseClock(live)
    this.dequeue(live.run.id)
    this.runs.delete(live.run.id)
    const run: RoutineRun = {
      ...live.run,
      status: 'skipped',
      reason: 'plan_limit',
      sessionId: null,
      startedAt: null,
      endedAt: this.now(),
      workingMs: 0,
      seen: false,
    }
    // A skip recorded after this run started waiting is the latest; later skips follow that one.
    if (!this.lastSkips.has(run.routineId)) this.lastSkips.set(run.routineId, run)
    this.persist(run)
    this.emit(run)
    void this.publish(run.routineId)
    this.setWorking()
    this.deps.log('info', `Run ${run.id} of ${this.nameOf(run.routineId)}: skipped (plan_limit)`)
    if (this.routines.get(run.routineId)?.trigger.schedule.kind === 'once') {
      this.finishOnce(run.routineId)
    }
    this.startNext()
  }

  private notify(run: RoutineRun): void {
    if (!run.sessionId) return
    const name = this.nameOf(run.routineId)
    if (run.status === 'succeeded') {
      this.deps.events.attention(
        'routine-ended',
        run.sessionId,
        name,
        firstLine(run.output) ?? t('routines.ended'),
      )
    } else if (run.status === 'failed' || run.status === 'timed_out') {
      // A failed run ends too, so it follows the same switch and says why it failed.
      this.deps.events.attention(
        'routine-ended',
        run.sessionId,
        t('routines.failed', { name }),
        run.error?.message ?? t('routines.timedOut'),
      )
    }
  }

  private startNext(): void {
    if (this.stopped) return
    while (this.workingCount() < WORKING_RUNS && this.queued.length > 0) {
      const runId = this.queued.shift()!
      const live = this.runs.get(runId)
      if (!live || live.run.status !== 'queued') continue
      void this.begin(live)
    }
  }

  private dequeue(runId: string): void {
    const at = this.queued.indexOf(runId)
    if (at >= 0) this.queued.splice(at, 1)
  }

  private workingCount(): number {
    return [...this.runs.values()].filter((live) => isWorking(live.run)).length
  }

  private setWorking(): void {
    const working = [...this.runs.values()].some(
      (live) => live.run.status === 'starting' || live.run.status === 'running',
    )
    if (working === this.working) return
    this.working = working
    this.deps.events.working(working)
  }

  private resumeClock(live: LiveRun): void {
    if (live.workingSince === null) live.workingSince = this.now()
    this.arm(live)
  }

  private pauseClock(live: LiveRun): void {
    if (live.workingSince !== null) {
      live.run.workingMs += Math.max(0, this.now() - live.workingSince)
      live.workingSince = null
    }
    if (live.timer) clearTimeout(live.timer)
    live.timer = null
  }

  private arm(live: LiveRun): void {
    if (live.timer) clearTimeout(live.timer)
    live.timer = null
    if (live.run.status !== 'running' || live.workingSince === null) return
    const routine = this.routines.get(live.run.routineId)
    if (!routine) return
    const worked = live.run.workingMs + Math.max(0, this.now() - live.workingSince)
    const left = routine.timeLimitMinutes * this.timings.minuteMs - worked
    if (left <= 0) {
      void this.reachLimit(live)
      return
    }
    live.timer = setTimeout(() => void this.reachLimit(live), left)
    live.timer.unref?.()
  }

  private async reachLimit(live: LiveRun): Promise<void> {
    if (live.run.status !== 'running' || live.intent) return
    live.intent = 'timed_out'
    this.pauseClock(live)
    const sessionId = live.run.sessionId
    if (!sessionId) {
      this.finish(live, 'timed_out', {})
      return
    }
    await this.deps.sessions.cancel(sessionId).catch((error: unknown) => {
      this.deps.log('warn', `Could not stop the run at its time limit: ${messageOf(error)}`)
      this.finish(live, 'timed_out', {})
    })
  }

  private liveOfSession(sessionId: string): LiveRun | null {
    const runId = this.bySession.get(sessionId)
    return runId ? (this.runs.get(runId) ?? null) : null
  }

  private async routineFolder(routineId: string): Promise<string> {
    const folder = path.join(this.deps.userDataPath, 'scratch', `routine-${routineId}`)
    await mkdir(folder, { recursive: true, mode: 0o700 })
    return folder
  }

  private async viewOf(routine: Routine): Promise<RoutineView> {
    const stats = await this.stats(routine.id)
    const pause = routine.enabled ? this.scheduler.pauseOf(routine.agentId) : null
    const state: RoutineView['state'] = !routine.enabled
      ? isDone(routine, stats.last)
        ? 'done'
        : 'off'
      : pause
        ? 'paused'
        : 'on'
    return {
      ...routine,
      state,
      nextRunAt: this.scheduler.nextRunAt(schedulerRoutine(routine)),
      pause: pause ? pauseView(pause) : null,
      activeRun: stats.active,
      lastRun: stats.last,
      unseen: { failed: stats.unseenFailed, ended: stats.unseenEnded },
      sessions: stats.sessions,
    }
  }

  private async stats(routineId: string): Promise<RoutineRunStats> {
    if (!this.deps.threads) {
      return { sessions: 0, unseenFailed: 0, unseenEnded: 0, last: null, active: null }
    }
    return this.deps.threads.routine('stats', { routineId })
  }

  private async publish(routineId: string): Promise<void> {
    const routine = this.routines.get(routineId)
    if (!routine) return
    try {
      // The view counts what the database holds, so its writes come first.
      if (this.writes.size > 0) await Promise.allSettled([...this.writes])
      const view = await this.viewOf(routine)
      const json = JSON.stringify(view)
      if (this.lastViews.get(routineId) === json) return
      this.lastViews.set(routineId, json)
      this.deps.events.changed(view)
    } catch (error) {
      // The thread store may be closing, as at quit; a view that cannot be counted is not sent.
      if (!this.stopped) {
        this.deps.log('warn', `Could not update the view of ${routine.name}: ${messageOf(error)}`)
      }
    }
  }

  private routineOf(routineId: string): Routine {
    const routine = this.routines.get(routineId)
    if (!routine) throw new HostError('not_found', t('routines.notFound'))
    return routine
  }

  private nameOf(routineId: string): string {
    return this.routines.get(routineId)?.name ?? t('routines.unnamed')
  }

  private save(): void {
    this.deps.file.save({ version: 1, routines: [...this.routines.values()] })
  }

  private persist(run: RoutineRun): void {
    const threads = this.deps.threads
    if (!threads) return
    const writing = threads
      .routine('put', { routineId: run.routineId, run })
      .catch((error: unknown) => {
        this.deps.log(
          'warn',
          `Could not store a run of ${this.nameOf(run.routineId)}: ${messageOf(error)}`,
        )
      })
    this.writes.add(writing)
    void writing.finally(() => this.writes.delete(writing))
  }

  private emit(run: RoutineRun): void {
    this.deps.events.run({ ...run })
  }

  private call<K extends RoutineCallName>(
    name: K,
    params: RoutineCalls[K]['params'],
  ): Promise<RoutineCalls[K]['result']> {
    if (!this.deps.threads) return Promise.reject(new Error('The thread database is not open'))
    return this.deps.threads.routine(name, params)
  }
}

/** What the scheduler needs to know of a routine. */
function schedulerRoutine(routine: Routine): SchedulerRoutine {
  return {
    id: routine.id,
    agentId: routine.agentId,
    schedule: routine.trigger.schedule,
    enabled: routine.enabled,
    checkedThrough: routine.checkedThrough,
  }
}

function pauseView({ agentId, limit }: LimitPause): NonNullable<RoutineView['pause']> {
  return {
    agentId,
    window: limit.window,
    // A reached window says so, whatever use it reported last.
    usedPercent: limit.state === 'reached' ? null : limit.usedPercent,
    resetsAt: limit.resetsAt,
  }
}

/** A plan-limit window's name: OverBench's for the windows it knows, else the agent's own. */
function windowName(limit: PlanLimit): string {
  const key = `planWindow.${limit.window}`
  if (hasMessage(key)) return (t as (key: string) => string)(key)
  // Claude Code names a weekly limit per model, "Weekly · Fable", in English.
  const weekly = /^Weekly · (.+)$/.exec(limit.label)
  return weekly ? t('planWindow.weeklyOf', { model: weekly[1]! }) : limit.label
}

const DAY = 24 * 60 * 60_000

/** When a window resets: the clock time today, with the weekday within six days, else the date. */
function resetTime(at: number, now: number): string {
  const day = (time: number): number => new Date(time).setHours(0, 0, 0, 0)
  // Rounded, since a day across a clock change is not 24 hours.
  const days = Math.round((day(at) - day(now)) / DAY)
  const clock: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' }
  const options: Intl.DateTimeFormatOptions =
    days === 0
      ? clock
      : days > 0 && days <= 6
        ? { ...clock, weekday: 'short' }
        : { ...clock, month: 'short', day: 'numeric' }
  return new Intl.DateTimeFormat(currentLocale(), options).format(at)
}

// Pi has no mode to set; its caption says it does not ask before it acts.
const ASKING_MODES: Partial<Record<AgentId, Record<PermissionScope['level'], string>>> = {
  'claude-code': { read: 'default', edit: 'default', commands: 'default' },
  codex: { read: 'read-only', edit: 'workspace-write', commands: 'workspace-write' },
  opencode: { read: 'plan', edit: 'build', commands: 'build' },
  'fake-agent': { read: 'ask', edit: 'ask', commands: 'ask' },
}

/** The mode each level names for the agent, from the observed table. */
function askingMode(agentId: AgentId, level: PermissionScope['level']): string | null {
  return ASKING_MODES[agentId]?.[level] ?? null
}

function isWorking(run: RoutineRun): boolean {
  return run.status === 'starting' || run.status === 'running' || run.status === 'waiting'
}

function isDone(routine: Routine, last: RoutineRun | null): boolean {
  return routine.trigger.schedule.kind === 'once' && last?.endedAt != null
}

/** The user's name, or the prompt's first line cut to 60 characters. */
function routineName(name: string, prompt: string): string {
  const trimmed = name.trim()
  if (trimmed !== '') return Array.from(trimmed).slice(0, ROUTINE_NAME_CHARS).join('')
  const line =
    prompt
      .split('\n')
      .map((part) => part.trim())
      .find((part) => part !== '') ?? ''
  const chars = Array.from(line)
  return chars.length > ROUTINE_NAME_FROM_PROMPT
    ? chars.slice(0, ROUTINE_NAME_FROM_PROMPT).join('').trimEnd()
    : line
}

/** The first line of an output, as plain text, to say what a finished run found. */
function firstLine(output: string | null): string | null {
  if (!output) return null
  return markdownFirstLine(output) || null
}

/** A run keeps at most 64 KB of output, on a character boundary. */
function cutOutput(output: string | null): string | null {
  if (output === null || output === '') return null
  if (Buffer.byteLength(output, 'utf8') <= RUN_OUTPUT_BYTES) return output
  let bytes = 0
  let cut = ''
  for (const char of output) {
    const size = Buffer.byteLength(char, 'utf8')
    if (bytes + size > RUN_OUTPUT_BYTES) break
    bytes += size
    cut += char
  }
  return cut
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
