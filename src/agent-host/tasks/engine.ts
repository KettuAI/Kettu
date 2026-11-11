// The task engine: the only thing that moves a task between its workflow's stages. A pull
// scheduler fills free stage-session slots; agents only submit results, which the engine checks
// against the stage's contract and evidence before its gate decides where the task goes.

import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { harnessOf } from '@shared/agents'
import { markdownFirstLine } from '@shared/markdown-line'
import {
  MAX_TASK_SESSIONS,
  NOTE_CHARS,
  REQUIREMENT_CHARS,
  TITLE_CHARS,
  type AgentStage,
  type HandoverStage,
  type HumanStage,
  type StageCondition,
  type StageRunState,
  type StageRunView,
  type TaskDecision,
  type TaskDraft,
  type TaskPriority,
  type TaskTier,
  type TaskView,
  type TierSettings,
  type WorkflowStage,
} from '@shared/tasks'
import { HostError, invalidParams, notFound } from '../errors'
import { t } from '../i18n'
import { SYSTEM_CLOCK, type RoutineClock } from '../routines/scheduler'
import type { LogFn } from '../storage'
import type {
  StageRunRecord,
  StageSubmission,
  SubmitAnswer,
  TaskEngineApi,
  TaskEvents,
  TaskRecord,
  TaskRuntime,
  TasksFile,
} from './api'
import { checkSubmission } from './checks'
import {
  handoverSummary,
  notesFromResult,
  recoveryMessage,
  reminderMessage,
  reworkMessage,
  stageMessage,
  type EarlierResult,
} from './prompts'
import { emptyTasksFile, TASK_ID, type TasksStore } from './store'
import { defaultTiers, nearLimit, parseTierSettings, pickCandidate, stepUp } from './tiers'

/** How often working time, stage time limits and plan-limit pauses are looked at. */
export const TICK_MS = 30_000
export const TITLE_FROM_REQUIREMENT = 80
const MAX_AFTER = 50
const PRIORITY_RANK: Record<TaskPriority, number> = { high: 0, normal: 1, low: 2 }
const PRIORITIES: ReadonlySet<unknown> = new Set(['low', 'normal', 'high'])
/** Rounds that ran to a result; an interrupted round is carried on, not counted. */
const COMPLETED: ReadonlySet<StageRunState> = new Set(['passed', 'changes', 'blocked'])
const RESTART_NOTE = 'Kettu stopped while the stage ran'

export interface TaskEngineDeps {
  runtime: TaskRuntime
  file: TasksStore
  events: TaskEvents
  log: LogFn
  timers?: Pick<RoutineClock, 'setTimeout' | 'clearTimeout'>
  /** Stage sessions working at once; MAX_TASK_SESSIONS by default. */
  maxSessions?: number
}

function newId(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString('hex')}`
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isWorking(run: StageRunRecord): boolean {
  return run.kind === 'agent' && (run.state === 'running' || run.state === 'waiting')
}

/** Any one key that matches runs the stage; a condition without keys always holds. */
function conditionHolds(when: StageCondition, task: TaskRecord): boolean {
  if (when.size === undefined && when.risk === undefined) return true
  if (when.size && task.size !== null && when.size.includes(task.size)) return true
  return when.risk !== undefined && when.risk === task.risk
}

export function taskView(task: TaskRecord): TaskView {
  return {
    id: task.id,
    title: task.title,
    requirement: task.requirement,
    projectPath: task.projectPath,
    workflow: { ...task.workflow },
    stages: task.snapshot.stages.map((stage) => ({
      id: stage.id,
      name: stage.name,
      kind: stage.kind,
      ...(stage.kind === 'human' ? { sendBack: [...stage.sendBack] } : {}),
    })),
    state: task.state,
    reason: task.reason,
    stageId: task.stageId,
    priority: task.priority,
    after: [...task.after],
    size: task.size,
    risk: task.risk,
    worktree: task.worktree
      ? { path: task.worktree.path, branch: task.worktree.branch, base: task.worktree.base }
      : null,
    pullRequest: task.pullRequest,
    costUsd: task.costUsd,
    createdBy: task.createdBy,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    lastViewedAt: task.lastViewedAt,
  }
}

export function runView(run: StageRunRecord): StageRunView {
  return {
    id: run.id,
    taskId: run.taskId,
    stageId: run.stageId,
    round: run.round,
    kind: run.kind,
    state: run.state,
    sessionId: run.sessionId,
    agentId: run.agentId,
    model: run.model,
    tier: run.tier,
    summary: run.summary,
    fields: structuredClone(run.fields),
    evidence: run.evidence
      ? { commands: [...run.evidence.commands], changedFiles: [...run.evidence.changedFiles] }
      : null,
    note: run.note,
    costUsd: run.costUsd,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
  }
}

export class TaskEngine implements TaskEngineApi {
  private data: TasksFile = emptyTasksFile()
  private loaded = false
  /** Each task's async work in turn, so a dispatch, a submission and a turn's end never race. */
  private readonly locks = new Map<string, Promise<void>>()
  private passing: Promise<void> | null = null
  private again = false
  /** Working runs being timed, from when. */
  private readonly active = new Map<string, number>()
  private suspended = false
  private timer: unknown = null

  constructor(private readonly deps: TaskEngineDeps) {}

  private get rt(): TaskRuntime {
    return this.deps.runtime
  }

  private now(): number {
    return this.rt.now()
  }

  private get maxSessions(): number {
    return this.deps.maxSessions ?? MAX_TASK_SESSIONS
  }

  // Loading and recovery.

  async load(): Promise<void> {
    this.data = await this.deps.file.load()
    for (const run of this.data.runs) {
      if (run.state !== 'running' && run.state !== 'waiting') continue
      const task = this.data.tasks.find((t) => t.id === run.taskId)
      if (!task || run.kind === 'human') continue
      // A round cut off by a shutdown is carried on in its session; a second cut blocks it.
      const before = this.runsOf(task.id, run.stageId).filter((r) => r !== run)
      const twice = before.at(-1)?.state === 'interrupted' && before.at(-1)?.note === RESTART_NOTE
      this.endRun(run, 'interrupted', RESTART_NOTE)
      if (task.state === 'cancelled' || task.state === 'done') continue
      if (twice) {
        const stage = this.stageIn(task, run.stageId)
        this.block(task, `The "${stage?.name ?? run.stageId}" stage was interrupted twice.`)
      } else if (!task.pausedByUser) {
        task.state = 'queued'
        task.reason = null
      }
    }
    // A task left running with no round to show for it starts its stage again.
    for (const task of this.data.tasks) {
      if (task.state !== 'running' && task.state !== 'waiting') continue
      if (this.data.runs.some((r) => r.taskId === task.id && r.state === 'waiting')) continue
      task.state = 'queued'
      task.reason = null
    }
    this.loaded = true
    this.save()
    this.arm()
    this.schedule()
  }

  /** Stops the timer; for tests and shutdown. */
  dispose(): void {
    if (this.timer !== null) (this.deps.timers ?? SYSTEM_CLOCK).clearTimeout(this.timer)
    this.timer = null
  }

  private arm(): void {
    const timers = this.deps.timers ?? SYSTEM_CLOCK
    this.timer = timers.setTimeout(() => {
      this.timer = null
      this.tick()
      this.arm()
    }, TICK_MS)
  }

  /** Adds up working time, stops stages over their time limit and retries plan-limit pauses. */
  tick(): void {
    for (const run of this.data.runs) {
      if (run.kind !== 'agent' || run.state !== 'running') continue
      this.accrue(run)
      const task = this.data.tasks.find((t) => t.id === run.taskId)
      if (!task) continue
      if (run.workedMs < task.snapshot.limits.stageMinutes * 60_000) continue
      void this.withTask(task.id, async () => {
        if (!isWorking(run)) return
        const stage = this.stageIn(task, run.stageId)
        const reason = t('tasks.reason.timeLimit', {
          stage: stage?.name ?? run.stageId,
          minutes: task.snapshot.limits.stageMinutes,
        })
        this.endRun(run, 'blocked', reason)
        this.block(task, reason)
        if (run.sessionId) await this.stopSession(run.sessionId)
      })
    }
    this.save()
    this.schedule()
  }

  /** Resolves once no pass or task work is in flight; for tests. */
  async idle(): Promise<void> {
    for (let i = 0; i < 1000; i++) {
      await Promise.all([this.passing, ...this.locks.values()])
      await new Promise((resolve) => setImmediate(resolve))
      if (!this.passing && this.locks.size === 0) return
    }
  }

  // Reads.

  list(): TaskView[] {
    return this.data.tasks.map(taskView)
  }

  get(taskId: string): { task: TaskView; runs: StageRunView[] } {
    const task = this.taskOf(taskId)
    return { task: taskView(task), runs: this.runsOf(taskId).map(runView) }
  }

  tiers(): TierSettings {
    return this.data.tiers ?? defaultTiers(this.rt.agents())
  }

  /** The stage a session is working on now; null once its round ended, so its scope lapses. */
  stageOf(sessionId: string): { taskId: string; runId: string; stageId: string } | null {
    const run = this.latestRunOf(sessionId)
    return run && isWorking(run)
      ? { taskId: run.taskId, runId: run.id, stageId: run.stageId }
      : null
  }

  // The person's actions.

  async create(draft: TaskDraft, by: 'user' | 'agent'): Promise<TaskView> {
    if (typeof draft.requirement !== 'string') throw invalidParams('The requirement is missing.')
    const requirement = draft.requirement.trim()
    if (requirement === '') throw invalidParams('The requirement is empty.')
    if (requirement.length > REQUIREMENT_CHARS) {
      throw invalidParams(`The requirement is longer than ${REQUIREMENT_CHARS} characters.`)
    }
    const written = typeof draft.title === 'string' ? draft.title.trim() : ''
    if (written.length > TITLE_CHARS) {
      throw invalidParams(`The title is longer than ${TITLE_CHARS} characters.`)
    }
    if (typeof draft.projectPath !== 'string' || !path.isAbsolute(draft.projectPath)) {
      throw invalidParams('The project path must be absolute.')
    }
    const priority = draft.priority ?? 'normal'
    if (!PRIORITIES.has(priority)) throw invalidParams('The priority is not low, normal or high.')
    const after = draft.after ?? []
    if (
      !Array.isArray(after) ||
      after.length > MAX_AFTER ||
      new Set(after).size !== after.length ||
      !after.every((id) => typeof id === 'string' && TASK_ID.test(id))
    ) {
      throw invalidParams('The tasks to wait for are malformed.')
    }
    for (const id of after) {
      if (!this.data.tasks.some((t) => t.id === id)) throw notFound(`No task ${id} to wait for.`)
    }
    if (typeof draft.workflow?.id !== 'string' || typeof draft.workflow.source !== 'string') {
      throw invalidParams('The workflow is missing.')
    }
    const { workflow, hash } = await this.rt.workflow(
      draft.projectPath,
      draft.workflow.source,
      draft.workflow.id,
    )
    // A task an agent made waits in the backlog for the person to start it.
    const start = draft.start === true && by === 'user'
    const now = this.now()
    const title =
      written ||
      (markdownFirstLine(requirement) || requirement.split('\n')[0]!.trim()).slice(
        0,
        TITLE_FROM_REQUIREMENT,
      )
    const task: TaskRecord = {
      id: newId('t'),
      title,
      requirement,
      projectPath: draft.projectPath,
      workflow: {
        source: draft.workflow.source,
        id: workflow.id,
        version: workflow.version,
        hash,
        name: workflow.name,
      },
      snapshot: workflow,
      state: start ? 'queued' : 'backlog',
      reason: null,
      stageId: start ? workflow.start : null,
      priority,
      after: [...after],
      size: null,
      risk: false,
      worktree: null,
      pullRequest: null,
      costUsd: 0,
      createdBy: by,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      endedAt: null,
      lastViewedAt: null,
      rounds: {},
      pausedByUser: false,
      notes: null,
    }
    this.data.tasks.push(task)
    this.changed(task)
    this.deps.log('info', `Task ${task.id} created (${workflow.id}, ${task.state})`)
    this.schedule()
    return taskView(task)
  }

  start(taskId: string): TaskView {
    const task = this.taskOf(taskId)
    if (task.state === 'queued') return taskView(task)
    if (task.state !== 'backlog') throw new HostError('conflict', 'Only a backlog task can start.')
    task.state = 'queued'
    task.reason = null
    task.stageId ??= task.snapshot.start
    this.changed(task)
    this.schedule()
    return taskView(task)
  }

  pause(taskId: string): TaskView {
    const task = this.taskOf(taskId)
    if (task.state === 'paused' && task.pausedByUser) return taskView(task)
    if (!['queued', 'running', 'waiting', 'paused'].includes(task.state)) {
      throw new HostError('conflict', `A ${task.state} task cannot be paused.`)
    }
    const run = this.workingRunOf(task)
    if (run) {
      this.endRun(run, 'interrupted', t('tasks.reason.pausedByPerson'))
      if (run.sessionId) void this.stopSession(run.sessionId)
    }
    task.state = 'paused'
    task.pausedByUser = true
    task.reason = t('tasks.reason.paused')
    this.changed(task)
    return taskView(task)
  }

  resume(taskId: string): TaskView {
    const task = this.taskOf(taskId)
    if (task.state !== 'paused') throw new HostError('conflict', 'The task is not paused.')
    task.pausedByUser = false
    const human = this.waitingHumanRun(task)
    if (human) {
      task.state = 'waiting'
      task.reason = (this.stageIn(task, human.stageId) as HumanStage | undefined)?.prompt ?? null
    } else {
      task.state = 'queued'
      task.reason = null
    }
    this.changed(task)
    this.schedule()
    return taskView(task)
  }

  cancel(taskId: string): Promise<TaskView> {
    this.taskOf(taskId)
    return this.withTask(taskId, async () => {
      const task = this.taskOf(taskId)
      if (task.state === 'done' || task.state === 'cancelled') return taskView(task)
      const run = this.runsOf(taskId).find((r) => r.state === 'running' || r.state === 'waiting')
      if (run) this.endRun(run, 'interrupted', t('tasks.reason.cancelledByPerson'))
      task.state = 'cancelled'
      task.reason = null
      task.endedAt = this.now()
      this.changed(task)
      if (run?.sessionId && run.kind === 'agent') await this.stopSession(run.sessionId)
      this.schedule()
      return taskView(task)
    })
  }

  decide(decision: TaskDecision): Promise<TaskView> {
    this.taskOf(decision.taskId)
    if (decision.note !== undefined && typeof decision.note !== 'string') {
      throw invalidParams('The note must be text.')
    }
    const note = decision.note?.trim() || null
    if (note && note.length > NOTE_CHARS) {
      throw invalidParams(`The note is longer than ${NOTE_CHARS} characters.`)
    }
    return this.withTask(decision.taskId, async () => {
      const task = this.taskOf(decision.taskId)
      const human = this.waitingHumanRun(task)
      if (task.state === 'waiting' && human) {
        const stage = this.stageIn(task, human.stageId) as HumanStage
        if (decision.decision === 'approve') {
          this.endRun(human, 'passed', note)
          this.moveOn(task, stage)
        } else {
          if (!decision.to || !stage.sendBack.includes(decision.to)) {
            throw invalidParams(`"${stage.name}" can send the task back only to its listed stages.`)
          }
          this.endRun(human, 'changes', note)
          task.rounds[stage.id] = (task.rounds[stage.id] ?? 0) + 1
          this.sendBack(task, decision.to, note && `From the person at "${stage.name}": ${note}`)
        }
        return taskView(task)
      }
      if (task.state !== 'blocked') {
        throw new HostError('conflict', 'The task is not waiting for a decision.')
      }
      // The person grants the blocked stage a fresh set of rework rounds.
      if (task.stageId) task.rounds[task.stageId] = 0
      const personNote = note && `From the person: ${note}`
      if (decision.decision === 'approve') {
        this.sendBack(task, task.stageId ?? task.snapshot.start, personNote)
      } else {
        const to = decision.to ? this.stageIn(task, decision.to) : undefined
        const current = task.stageId ? this.stageIn(task, task.stageId) : undefined
        const allowed =
          to !== undefined &&
          (to.kind === 'agent' || (current?.kind === 'human' && current.sendBack.includes(to.id)))
        if (!allowed) throw invalidParams('A blocked task goes back only to an agent stage.')
        this.sendBack(task, to.id, personNote)
      }
      return taskView(task)
    })
  }

  markSeen(taskId: string): void {
    const task = this.taskOf(taskId)
    task.lastViewedAt = this.now()
    this.save()
    this.deps.events.changed(taskView(task))
  }

  setTiers(tiers: TierSettings): TierSettings {
    const parsed = parseTierSettings(tiers)
    if (typeof parsed === 'string') throw invalidParams(parsed)
    this.data.tiers = parsed
    this.save()
    this.schedule()
    return parsed
  }

  flush(): Promise<void> {
    return this.deps.file.flush()
  }

  // What the host reports of stage sessions.

  submit(sessionId: string, submission: StageSubmission): Promise<SubmitAnswer> {
    const known = this.latestRunOf(sessionId)
    if (!known) {
      return Promise.resolve({ ok: false, error: 'This session is not a task stage.' })
    }
    return this.withTask(known.taskId, async (): Promise<SubmitAnswer> => {
      const closed: SubmitAnswer = {
        ok: false,
        error: 'This stage is not open for a result now; there is nothing to submit.',
      }
      const run = this.workingRunOfSession(sessionId)
      const task = run && this.data.tasks.find((t) => t.id === run.taskId)
      if (!run || !task || task.stageId !== run.stageId) return closed
      if (task.state !== 'running' && task.state !== 'waiting') return closed
      const stage = this.stageIn(task, run.stageId)
      if (stage?.kind !== 'agent') return closed
      let evidence
      try {
        evidence = await this.rt.evidence(sessionId, run.fromTurn)
      } catch (error) {
        return {
          ok: false,
          error: `Kettu could not read this session's tool calls (${message(error)}). Try again.`,
        }
      }
      if (!isWorking(run)) return closed
      this.recordCost(task, run, evidence.costUsd)
      const check = checkSubmission(stage, submission, evidence)
      if (!check.ok) {
        this.runChanged(run)
        return check
      }
      run.summary = submission.summary.trim()
      run.fields = check.fields
      run.evidence = { commands: [...evidence.commands], changedFiles: [...evidence.changedFiles] }
      if (submission.escalate === true) run.escalate = true
      for (const field of stage.contract) {
        const value = check.fields[field.name]
        if (field.type === 'size' && (value === 'S' || value === 'M' || value === 'L')) {
          task.size = value
        }
        if (field.type === 'risk' && typeof value === 'boolean') task.risk = value
      }
      const done = ' Your work on this stage is finished; end your turn.'
      if (submission.verdict === 'blocked') {
        this.endRun(run, 'blocked', run.summary)
        this.block(task, run.summary)
        return { ok: true, next: `Accepted. The task waits for the person.${done}` }
      }
      if (submission.verdict === 'changes') {
        const edge = stage.rework!
        const used = task.rounds[stage.id] ?? 0
        this.endRun(run, 'changes', run.summary)
        if (used >= edge.rounds) {
          this.block(
            task,
            `The rework limit of ${edge.rounds} rounds was reached at "${stage.name}".`,
          )
          return {
            ok: true,
            next: `Accepted. The rework limit is reached, so the task waits for the person.${done}`,
          }
        }
        task.rounds[stage.id] = used + 1
        if (this.overBudget(task)) return this.budgetBlock(task, done)
        this.sendBack(task, edge.to, notesFromResult(stage, run))
        const target = this.stageIn(task, edge.to)
        return {
          ok: true,
          next: `Accepted. The task goes back to "${target?.name ?? edge.to}".${done}`,
        }
      }
      this.endRun(run, 'passed', null)
      if (this.overBudget(task)) return this.budgetBlock(task, done)
      const next = stage.next ? this.stageIn(task, stage.next) : undefined
      this.moveOn(task, stage)
      return {
        ok: true,
        next: next
          ? `Accepted. The task moves on to "${next.name}".${done}`
          : `Accepted. The task is done.${done}`,
      }
    })
  }

  turnEnded(sessionId: string): void {
    const known = this.workingRunOfSession(sessionId)
    if (!known) return
    void this.withTask(known.taskId, async () => {
      const run = this.workingRunOfSession(sessionId)
      const task = run && this.data.tasks.find((t) => t.id === run.taskId)
      if (!run || !task) return
      // A turn that began before this round, ending late, says nothing about the round.
      if (this.rt.turns(sessionId) <= run.fromTurn) return
      const stage = this.stageIn(task, run.stageId) as AgentStage
      const evidence = await this.rt.evidence(sessionId, run.fromTurn).catch(() => null)
      if (!isWorking(run)) return
      if (evidence) this.recordCost(task, run, evidence.costUsd)
      if (this.overBudget(task)) {
        this.budgetBlock(task, '')
        return
      }
      if (!run.nudged) {
        run.nudged = true
        this.runChanged(run)
        try {
          await this.rt.send(sessionId, reminderMessage(stage))
        } catch (error) {
          if (!isWorking(run)) return
          const reason = t('tasks.reason.remindFailed', {
            stage: stage.name,
            error: message(error),
          })
          this.endRun(run, 'interrupted', reason)
          this.block(task, reason)
        }
        return
      }
      const reason = t('tasks.reason.stalled', { stage: stage.name })
      this.endRun(run, 'blocked', reason)
      this.block(task, reason)
    })
  }

  waiting(sessionId: string, waiting: boolean): void {
    const run = this.workingRunOfSession(sessionId)
    const task = run && this.data.tasks.find((t) => t.id === run.taskId)
    if (!run || !task) return
    if (waiting && run.state === 'running') {
      this.accrue(run)
      this.active.delete(run.id)
      run.state = 'waiting'
      this.runChanged(run)
      if (task.state === 'running') {
        task.state = 'waiting'
        task.reason = t('tasks.reason.waitingPermission')
        this.changed(task)
      }
    } else if (!waiting && run.state === 'waiting') {
      run.state = 'running'
      this.activate(run)
      this.runChanged(run)
      if (task.state === 'waiting') {
        task.state = 'running'
        task.reason = null
        this.changed(task)
      }
    }
  }

  sessionGone(sessionId: string): void {
    const run = this.workingRunOfSession(sessionId)
    const task = run && this.data.tasks.find((t) => t.id === run.taskId)
    if (!run || !task) return
    const stage = this.stageIn(task, run.stageId)
    const reason = t('tasks.reason.sessionClosed', { stage: stage?.name ?? run.stageId })
    this.endRun(run, 'interrupted', reason)
    this.block(task, reason)
    this.schedule()
  }

  /** Any agent's limits may free a candidate, since tiers list several agents. */
  limitsChanged(): void {
    this.schedule()
  }

  power(state: 'suspend' | 'resume'): void {
    if (state === 'suspend') {
      for (const run of this.data.runs) if (this.active.has(run.id)) this.accrue(run)
      this.active.clear()
      this.suspended = true
      this.save()
      return
    }
    this.suspended = false
    for (const run of this.data.runs) {
      if (run.kind === 'agent' && run.state === 'running') this.activate(run)
    }
    this.schedule()
  }

  // The scheduler.

  private schedule(): void {
    if (!this.loaded) return
    this.again = true
    if (this.passing) return
    this.passing = (async () => {
      while (this.again) {
        this.again = false
        await this.pass()
      }
    })()
      .catch((error: unknown) =>
        this.deps.log('error', `Task scheduling failed: ${message(error)}`),
      )
      .finally(() => {
        this.passing = null
        if (this.again) this.schedule()
      })
  }

  /** Moves every task that can move: in-progress tasks first, then by priority, then age. */
  private async pass(): Promise<void> {
    const ready = this.data.tasks
      .filter((task) => this.dispatchable(task) && this.afterDone(task))
      .sort(
        (a, b) =>
          Number(a.startedAt === null) - Number(b.startedAt === null) ||
          PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
          a.createdAt - b.createdAt,
      )
    for (const task of ready) {
      await this.withTask(task.id, async () => {
        try {
          await this.advance(task)
        } catch (error) {
          this.deps.log('error', `Task ${task.id} could not move on: ${message(error)}`)
          if (this.dispatchable(task)) this.block(task, `Kettu could not go on: ${message(error)}`)
        }
      })
    }
  }

  private dispatchable(task: TaskRecord): boolean {
    return task.state === 'queued' || (task.state === 'paused' && !task.pausedByUser)
  }

  private afterDone(task: TaskRecord): boolean {
    return task.after.every((id) => this.data.tasks.find((t) => t.id === id)?.state === 'done')
  }

  private busy(): number {
    return this.data.runs.filter(isWorking).length
  }

  private async advance(task: TaskRecord): Promise<void> {
    for (let guard = 0; guard <= task.snapshot.stages.length * 2; guard++) {
      if (!this.dispatchable(task) || !this.afterDone(task)) return
      task.stageId ??= task.snapshot.start
      const stage = this.stageIn(task, task.stageId)
      if (!stage) {
        this.block(task, `The workflow has no stage "${task.stageId}".`)
        return
      }
      if (stage.when && !conditionHolds(stage.when, task)) {
        const run = this.newRun(task, stage, this.roundOf(task, stage.id), { state: 'skipped' })
        run.endedAt = run.startedAt
        this.runChanged(run)
        this.moveOn(task, stage)
        continue
      }
      if (stage.kind === 'human') {
        const run = this.newRun(task, stage, this.roundOf(task, stage.id), { state: 'waiting' })
        this.runChanged(run)
        task.startedAt ??= this.now()
        task.state = 'waiting'
        task.reason = stage.prompt
        task.pausedByUser = false
        this.changed(task)
        this.rt.notify(taskView(task), 'needs-you')
        return
      }
      if (stage.kind === 'handover') {
        await this.handover(task, stage)
        continue
      }
      if (this.busy() >= this.maxSessions) return
      await this.dispatch(task, stage)
      return
    }
  }

  private async handover(task: TaskRecord, stage: HandoverStage): Promise<void> {
    const run = this.newRun(task, stage, this.roundOf(task, stage.id), {})
    task.state = 'running'
    task.reason = null
    this.changed(task)
    this.runChanged(run)
    let url: string
    try {
      url = await this.rt.handover(task, handoverSummary(task, this.earlierResults(task, stage.id)))
    } catch (error) {
      if (run.state !== 'running') return
      const reason = t('tasks.reason.pullRequestFailed', { error: message(error) })
      this.endRun(run, 'blocked', reason)
      this.block(task, reason)
      return
    }
    if (run.state !== 'running') return
    task.pullRequest = url
    run.summary = url
    this.endRun(run, 'passed', null)
    this.moveOn(task, stage)
  }

  private async dispatch(task: TaskRecord, stage: AgentStage): Promise<void> {
    if (task.snapshot.worktree && !task.worktree) {
      try {
        task.worktree = await this.rt.createWorktree(task, null)
      } catch (error) {
        if (this.dispatchable(task)) {
          this.block(task, `Could not create the task's worktree: ${message(error)}`)
        }
        return
      }
      this.changed(task)
      if (!this.dispatchable(task)) return
    }
    const prior = this.runsOf(task.id, stage.id).filter((r) => r.state !== 'skipped')
    const last = prior.at(-1)
    const round = prior.filter((r) => COMPLETED.has(r.state)).length + 1
    const now = this.now()
    const resume =
      last?.sessionId &&
      last.agentId &&
      (stage.session === 'resume' || last.state === 'interrupted') &&
      this.rt.alive(last.sessionId)
        ? { sessionId: last.sessionId, agentId: last.agentId }
        : null
    const resumeAgent = resume && this.rt.agents().find((a) => a.agentId === resume.agentId)
    if (resume && resumeAgent?.enabled && resumeAgent.canRunStages) {
      if (nearLimit(resumeAgent.limits, now)) {
        this.limitPause(task, t('tasks.reason.agentNearLimit', { agent: resume.agentId }))
        return
      }
      const run = this.newRun(task, stage, round, {
        sessionId: resume.sessionId,
        agentId: resume.agentId,
        model: last!.model,
        tier: last!.tier,
        fromTurn: this.rt.turns(resume.sessionId),
      })
      const notes = task.notes
      this.begin(task, run)
      const text =
        last!.state === 'interrupted' && !notes
          ? recoveryMessage(stage)
          : reworkMessage(stage, notes, round)
      try {
        await this.rt.send(resume.sessionId, text)
      } catch (error) {
        if (!isWorking(run)) return
        const reason = t('tasks.reason.sendFailed', { stage: stage.name, error: message(error) })
        this.endRun(run, 'interrupted', reason)
        this.block(task, reason)
      }
      return
    }
    const tier = this.tierFor(task, stage, round)
    const pick = pickCandidate(
      this.tiers(),
      tier,
      this.rt.agents(),
      this.avoidHarness(task, stage),
      now,
    )
    if (pick.kind === 'limit') {
      this.limitPause(
        task,
        t('tasks.reason.tierNearLimit', { tier: t(`tasks.reason.tiers.${tier}`) }),
      )
      return
    }
    if (pick.kind === 'none') {
      this.block(task, t('tasks.reason.tierEmpty', { tier: t(`tasks.reason.tiers.${tier}`) }))
      return
    }
    const run = this.newRun(task, stage, round, { agentId: pick.agent.agentId, tier })
    const notes = task.notes
    this.begin(task, run)
    const prompt = stageMessage({
      task,
      stage,
      earlier: this.earlierResults(task, stage.id),
      notes,
      round,
    })
    try {
      const opened = await this.rt.openSession({
        task,
        run,
        agentId: pick.agent.agentId,
        options: Object.fromEntries(pick.candidate.options.map((o) => [o.id, o.value])),
        prompt,
        scope: stage.scope,
        title: `${task.title} · ${stage.name}`,
      })
      run.sessionId = opened.sessionId
      run.model = opened.model
      this.runChanged(run)
      // Cancelled or paused while the session opened.
      if (!isWorking(run)) await this.stopSession(opened.sessionId)
    } catch (error) {
      if (!isWorking(run)) return
      const reason = t('tasks.reason.openFailed', { stage: stage.name, error: message(error) })
      this.endRun(run, 'interrupted', reason)
      this.block(task, reason)
    }
  }

  private begin(task: TaskRecord, run: StageRunRecord): void {
    task.startedAt ??= this.now()
    task.state = 'running'
    task.reason = null
    task.notes = null
    this.activate(run)
    this.changed(task)
    this.runChanged(run)
  }

  /** The stage's tier for this round: by size, one step up per earlier round and if asked. */
  private tierFor(task: TaskRecord, stage: AgentStage, round: number): TaskTier {
    const base =
      typeof stage.tier === 'string'
        ? stage.tier
        : ((task.size ? stage.tier[task.size] : undefined) ?? stage.tier.default)
    const ended = this.runsOf(task.id).filter((r) => r.endedAt !== null && r.state !== 'skipped')
    const asked = ended.at(-1)?.escalate === true ? 1 : 0
    return stepUp(base, round - 1 + asked)
  }

  private avoidHarness(task: TaskRecord, stage: AgentStage): string | null {
    const other = stage.requires?.otherHarnessThan
    if (!other) return null
    const runs = this.runsOf(task.id, other).filter((r) => r.agentId !== null)
    const run = runs.findLast((r) => r.state === 'passed') ?? runs.at(-1)
    return run?.agentId ? harnessOf(run.agentId) : null
  }

  // Moving a task.

  private moveOn(task: TaskRecord, stage: WorkflowStage): void {
    if (stage.next === null) {
      task.state = 'done'
      task.stageId = null
      task.reason = null
      task.endedAt = this.now()
      this.changed(task)
      this.rt.notify(taskView(task), 'done')
      return
    }
    task.stageId = stage.next
    task.state = 'queued'
    task.reason = null
    this.changed(task)
    this.schedule()
  }

  private sendBack(task: TaskRecord, to: string, notes: string | null): void {
    task.stageId = to
    task.notes = notes
    task.state = 'queued'
    task.reason = null
    this.changed(task)
    this.schedule()
  }

  private block(task: TaskRecord, reason: string): void {
    task.state = 'blocked'
    task.reason = reason
    this.changed(task)
    this.rt.notify(taskView(task), 'blocked')
  }

  private limitPause(task: TaskRecord, reason: string): void {
    if (task.state === 'paused' && task.reason === reason) return
    task.state = 'paused'
    task.pausedByUser = false
    task.reason = reason
    this.changed(task)
  }

  private overBudget(task: TaskRecord): boolean {
    const budget = task.snapshot.limits.budgetUsd
    return budget !== null && task.costUsd > budget
  }

  private budgetBlock(task: TaskRecord, done: string): SubmitAnswer {
    const run = this.workingRunOf(task)
    const reason = t('tasks.reason.overBudget', { budget: task.snapshot.limits.budgetUsd ?? 0 })
    if (run) {
      this.endRun(run, 'blocked', reason)
      if (run.sessionId) void this.stopSession(run.sessionId)
    }
    this.block(task, reason)
    return {
      ok: true,
      next: `Accepted. The task is over its budget and waits for the person.${done}`,
    }
  }

  private recordCost(task: TaskRecord, run: StageRunRecord, costUsd: number | undefined): void {
    if (costUsd === undefined || !Number.isFinite(costUsd) || costUsd < 0) return
    run.costUsd = costUsd
    task.costUsd = this.runsOf(task.id).reduce((sum, r) => sum + r.costUsd, 0)
  }

  private earlierResults(task: TaskRecord, except: string): EarlierResult[] {
    const latest = new Map<string, StageRunRecord>()
    for (const run of this.runsOf(task.id)) {
      if (run.state === 'passed' && run.stageId !== except) latest.set(run.stageId, run)
    }
    const results: EarlierResult[] = []
    for (const run of this.runsOf(task.id)) {
      const stage = this.stageIn(task, run.stageId)
      if (stage && latest.get(run.stageId) === run) results.push({ stage, run })
    }
    return results
  }

  // Runs.

  private newRun(
    task: TaskRecord,
    stage: WorkflowStage,
    round: number,
    init: Partial<StageRunRecord>,
  ): StageRunRecord {
    const run: StageRunRecord = {
      id: newId('sr'),
      taskId: task.id,
      stageId: stage.id,
      round,
      kind: stage.kind,
      state: 'running',
      sessionId: null,
      agentId: null,
      model: null,
      tier: null,
      summary: null,
      fields: {},
      evidence: null,
      note: null,
      costUsd: 0,
      startedAt: this.now(),
      endedAt: null,
      fromTurn: 0,
      nudged: false,
      workedMs: 0,
      ...init,
    }
    this.data.runs.push(run)
    return run
  }

  private roundOf(task: TaskRecord, stageId: string): number {
    return this.runsOf(task.id, stageId).filter((r) => COMPLETED.has(r.state)).length + 1
  }

  private endRun(run: StageRunRecord, state: StageRunState, note: string | null): void {
    this.accrue(run)
    this.active.delete(run.id)
    run.state = state
    run.note = note
    run.endedAt = this.now()
    this.runChanged(run)
  }

  private activate(run: StageRunRecord): void {
    if (!this.suspended) this.active.set(run.id, this.now())
  }

  private accrue(run: StageRunRecord): void {
    const since = this.active.get(run.id)
    if (since === undefined) return
    const now = this.now()
    run.workedMs += Math.max(0, now - since)
    this.active.set(run.id, now)
  }

  private async stopSession(sessionId: string): Promise<void> {
    try {
      await this.rt.stop(sessionId)
    } catch (error) {
      this.deps.log('warn', `Could not stop task session ${sessionId}: ${message(error)}`)
    }
  }

  // Lookups.

  private stageIn(task: TaskRecord, stageId: string): WorkflowStage | undefined {
    return task.snapshot.stages.find((stage) => stage.id === stageId)
  }

  private taskOf(taskId: string): TaskRecord {
    const task = this.data.tasks.find((t) => t.id === taskId)
    if (!task) throw notFound(`No task ${taskId}.`)
    return task
  }

  private runsOf(taskId: string, stageId?: string): StageRunRecord[] {
    return this.data.runs.filter(
      (run) => run.taskId === taskId && (stageId === undefined || run.stageId === stageId),
    )
  }

  private workingRunOf(task: TaskRecord): StageRunRecord | undefined {
    return this.runsOf(task.id).find(isWorking)
  }

  private waitingHumanRun(task: TaskRecord): StageRunRecord | undefined {
    return this.runsOf(task.id).find(
      (run) => run.kind === 'human' && run.state === 'waiting' && run.stageId === task.stageId,
    )
  }

  private workingRunOfSession(sessionId: string): StageRunRecord | undefined {
    return this.data.runs.find((run) => run.sessionId === sessionId && isWorking(run))
  }

  private latestRunOf(sessionId: string): StageRunRecord | undefined {
    return this.data.runs.findLast((run) => run.sessionId === sessionId)
  }

  // Persistence and events.

  private withTask<T>(taskId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(taskId) ?? Promise.resolve()
    const next = previous.then(work)
    const settled = next.then(
      () => undefined,
      () => undefined,
    )
    this.locks.set(taskId, settled)
    void settled.then(() => {
      if (this.locks.get(taskId) === settled) this.locks.delete(taskId)
    })
    return next
  }

  private save(): void {
    this.deps.file.save(this.data)
  }

  private changed(task: TaskRecord): void {
    task.updatedAt = this.now()
    this.save()
    this.deps.events.changed(taskView(task))
  }

  private runChanged(run: StageRunRecord): void {
    this.save()
    this.deps.events.run(runView(run))
  }
}

export function createTaskEngine(deps: TaskEngineDeps): TaskEngine {
  return new TaskEngine(deps)
}
