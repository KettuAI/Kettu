// Runs tasks through their workflows. A step's agent reports through Kettu's tools and only this engine
// moves a task: it follows only the arrows the workflow draws, never skips a step, checks that what a
// step hands in is there, and never judges the content. Who does a step is pinned by the user or
// picked by the agent that hands off to it; the engine only checks that a pick holds.

import { randomBytes } from 'node:crypto'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import {
  DEFAULT_WORKING_STEPS,
  MAX_TASK_NOTES,
  MAX_TASK_STEPS,
  isBackArrow,
  stepIndex,
  type CheckLine,
  type CheckNext,
  type PickCheck,
  type ReportCheck,
  type SentBack,
  type SessionTaskRef,
  type StepDeliverable,
  type StepTools,
  type WorkflowOutcome,
  type WorkflowStep,
  type StepPick,
  type StuckReason,
  type TaskEnd,
  type TaskStart,
  type TaskSummary,
  type TaskView,
} from '@shared/workflow'
import type { SessionSummary } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import { HostError, invalidParams, notFound } from '../errors'
import { t } from '../i18n'
import type { LogFn, WorktreeRecord } from '../storage'
import type { TaskGit } from './git'
import { arrowKey, forwardReach, outcomeOf, stepOf } from './graph'
import type { ResolvedWorkflow, WorkflowLibrary } from './library'
import {
  TASK_ID,
  type HeldPick,
  type LaneRecord,
  type RoundRecord,
  type TaskRecord,
  type WaitingRecord,
} from './model'
import {
  blockedFor,
  checkPick,
  factsFor,
  historyOf,
  type PickFacts,
  type PickInput,
  type RoleHint,
  type WorkflowAgent,
} from './picks'
import { againPrompt, notePrompt, reminderPrompt, resumePrompt, stepPrompt } from './prompts'
import { canPinStep, LIVE, needsOf, summaryOf, viewOf, WORKING } from './views'

/** Refused picks in a row before the task waits for the user. */
export const MAX_PICK_REFUSALS = 3

/** What the engine asks of the session manager for a step's session. */
export interface TaskStepStart {
  agentId: AgentId
  projectPath: string
  worktree: WorktreeRecord | null
  /** The worktree is new, so the session prepares it before its first message. */
  prepare: boolean
  options: Record<string, string | boolean>
  prompt: string
  title: string
  task: SessionTaskRef
  /** The step's role, by its reference; its session is given the role's instructions. */
  role?: string
}

export interface TaskSessions {
  createStep(params: TaskStepStart): Promise<SessionSummary>
  /**
   * Sends a message from Kettu, or queues it while the session works; a queued one goes out only
   * if `due`, asked when its turn comes, still says so.
   */
  send(sessionId: string, text: string, due?: () => boolean): Promise<void>
  /** Stops the session's turn, if one runs. */
  cancel(sessionId: string): Promise<void>
  delete(sessionId: string): Promise<void>
  has(sessionId: string): boolean
}

export interface TaskWorktrees {
  create(
    projectPath: string,
    request: { base: string; branch?: string; text: string },
    first?: Pick<TaskStart, 'agentId' | 'options'>,
  ): Promise<WorktreeRecord>
  /** Removes a worktree that is done with, never one with changes not committed. */
  remove(projectPath: string, record: WorktreeRecord, branch: 'keep' | 'delete'): Promise<void>
}

export type WrittenDocument =
  | { ok: true; version: number; title: string }
  | { ok: false; why: 'not_found' | 'not_document' | 'not_written' }

export interface TaskDocuments {
  /** The document artifact, when `sessionId` wrote a version of it at or after `since`. */
  written(artifactId: string, sessionId: string, since: number): Promise<WrittenDocument>
  /** The open comments on it, for a review sent back. */
  openComments(artifactId: string): Promise<string[]>
}

/** A step of a task as its start and its end are told: no note, report or text of the task. */
export interface TaskStepEvent {
  taskId: string
  title: string
  workflowName: string
  projectPath: string
  stepId: string
  stepName: string
  /** The round of the step, from 1. */
  round: number
  agentId: AgentId | null
  /** The outcome the step ended with; null for a step that started or was sent back. */
  outcome: string | null
}

export interface TaskEvents {
  /** A step started working, or ended: its outcome was followed or the person sent it back. */
  step?(event: 'started' | 'ended', info: TaskStepEvent): void
  changed(view: TaskView): void
  removed(taskId: string): void
  /** The task starts to need the user, or it ended or was cancelled. */
  attention(task: TaskSummary, kind: 'needs-you' | 'ended'): void
  /**
   * The task ended, done, dropped or cancelled, as it stands then; `written` when it ran on a
   * workflow an agent wrote for it alone.
   */
  ended?(view: TaskView, written: boolean): void
}

export interface TaskEngineDeps {
  store: {
    put(task: TaskRecord): Promise<null>
    all(): Promise<TaskRecord[]>
    remove(taskId: string): Promise<null>
  }
  library: WorkflowLibrary
  sessions: TaskSessions
  /** Writes a suggested task title, with the source session as its fallback. */
  titleTask(sessionId: string, text: string): Promise<string | null>
  /** Null on a host that makes no worktrees: every step works in the project folder. */
  worktrees: TaskWorktrees | null
  git: TaskGit
  documents: TaskDocuments
  /** The canonical folder of a project, which must exist. */
  resolveProject(projectPath: string): Promise<string>
  /** The host's agents as picks are checked against them. */
  agents(): WorkflowAgent[]
  /** The option values that start an agent's session with a pick's model and effort. */
  optionsOf(pick: StepPick): Record<string, string | boolean>
  /** The pick the tray's option values stand for. */
  pickOf(agentId: AgentId, options: Record<string, string | boolean>): StepPick
  /** What a role, by its reference, suggests; null when no role has it. */
  roleHint?(ref: string): Promise<RoleHint | null>
  events: TaskEvents
  /** Step sessions working at once across every task, as the user set it. */
  workingLimit?(): number
  /** The pull requests the sessions opened or found on their branches, as URLs. */
  pullRequests?(sessionIds: readonly string[]): string[]
  /** Whether a file or folder a report hands over is there. */
  exists?(path: string): Promise<boolean>
  log: LogFn
  now?(): number
  random?(): string
}

export interface ReportInput {
  outcome: string | null
  note: string | null
  artifactId: string | null
  /** Files, by a path absolute or from the step's folder, and links it hands over. */
  deliverables?: StepDeliverable[] | null
}

export interface ReportResult {
  accepted: boolean
  checks: CheckLine<ReportCheck>[]
  next: CheckNext
  /** What the agent picks from, when it must pick who does the next steps. */
  facts: PickFacts | null
}

export interface PickResult {
  accepted: boolean
  checks: { step: string; lines: CheckLine<PickCheck>[] }[]
  next: CheckNext
}

/** How a step session's hooks reach the engine; set once it exists. */
export interface TaskSessionHooks {
  /** The step's session exists, before anything is sent. */
  sessionCreated(sessionId: string, ref: SessionTaskRef): void
  /** A turn of the session ended; `byUser` when the user's own message started it. */
  turnEnded(sessionId: string, turn: { byUser: boolean }): void
  /** A request waits for the user in the session, or the last was answered. */
  waiting(sessionId: string, waiting: boolean): void
  sessionGone(sessionId: string): void
  /** The session works for its step now, so its requests are answered in the step's scope. */
  working(sessionId: string): boolean
}

export interface TaskSessionHooksRef {
  current: TaskSessionHooks | null
}

const MAIN = 'main'

async function pathExists(file: string): Promise<boolean> {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

export class TaskEngine implements TaskSessionHooks {
  private readonly tasks = new Map<string, TaskRecord>()
  /** Rounds by their session. */
  private readonly bySession = new Map<string, { taskId: string; roundId: string }>()
  private chain: Promise<unknown> = Promise.resolve()
  private timer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  private readonly now: () => number
  private readonly random: () => string
  private readonly exists: (path: string) => Promise<boolean>

  constructor(private readonly deps: TaskEngineDeps) {
    this.now = deps.now ?? Date.now
    this.random = deps.random ?? (() => randomBytes(6).toString('hex'))
    this.exists = deps.exists ?? pathExists
  }

  // Loading and the lock every change takes.

  async load(): Promise<void> {
    const tasks = await this.deps.store.all()
    for (const task of tasks) {
      this.tasks.set(task.id, task)
      for (const round of task.rounds) {
        if (round.sessionId)
          this.bySession.set(round.sessionId, { taskId: task.id, roundId: round.id })
      }
    }
    await this.locked(async () => {
      for (const task of this.tasks.values()) {
        if (task.status !== 'running') continue
        let changed = false
        for (const round of task.rounds) {
          if (round.state === 'starting') {
            // Its session may not have been made before the restart; make it again.
            round.state = 'queued'
            changed = true
          } else if ((round.state === 'working' || round.state === 'picking') && round.sessionId) {
            round.reminded = false
            const owed =
              round.state === 'picking' && round.picks
                ? round.picks.needed.filter((id) => !round.picks!.made.includes(id))
                : null
            void this.message(round.sessionId, resumePrompt(owed))
          }
        }
        if (changed) this.save(task)
      }
      this.pump()
    })
  }

  close(): void {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private locked<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.catch(() => {})
    return run
  }

  // Reading.

  list(): TaskSummary[] {
    return [...this.tasks.values()].map(summaryOf).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  get(taskId: string): TaskView {
    return this.view(this.task(taskId))
  }

  /** The draft a task that ended done ran on, which an agent wrote for it alone; null otherwise. */
  writtenDraft(taskId: string): string | null {
    const task = this.task(taskId)
    return task.workflowSource === 'agent' && task.status === 'done' ? task.workflowId : null
  }

  /** The drafts tasks ran on, which stay as long as their tasks. */
  draftIds(): Set<string> {
    const ids = new Set<string>()
    for (const task of this.tasks.values())
      if (task.workflowSource === 'agent') ids.add(task.workflowId)
    return ids
  }

  private view(task: TaskRecord): TaskView {
    const sessions = [...new Set(task.rounds.flatMap((r) => (r.sessionId ? [r.sessionId] : [])))]
    return viewOf(task, this.deps.pullRequests?.(sessions) ?? [])
  }

  /** The step a session works for, as its summary names it. */
  refOf(sessionId: string): SessionTaskRef | null {
    const ref = this.bySession.get(sessionId)
    if (!ref) return null
    const round = this.tasks.get(ref.taskId)?.rounds.find((r) => r.id === ref.roundId)
    return round ? { taskId: ref.taskId, stepId: round.stepId, roundId: round.id } : null
  }

  /** How long the workflow's tasks that ended done took: their count and the middle one. */
  pastRuns(workflowId: string): { runs: number; medianMs: number | null } {
    const took = [...this.tasks.values()]
      .filter((t) => t.workflowId === workflowId && t.status === 'done' && t.endedAt !== null)
      .map((t) => t.endedAt! - t.createdAt)
      .sort((a, b) => a - b)
    if (took.length === 0) return { runs: 0, medianMs: null }
    const mid = Math.floor(took.length / 2)
    const medianMs = took.length % 2 ? took[mid]! : Math.round((took[mid - 1]! + took[mid]!) / 2)
    return { runs: took.length, medianMs }
  }

  /** The MCP servers and Skills a step's session is handed, whoever does the step. */
  toolsOf(ref: SessionTaskRef): StepTools | null {
    const task = this.tasks.get(ref.taskId)
    return task ? (stepOf(task.workflow, ref.stepId)?.tools ?? null) : null
  }

  private task(taskId: string): TaskRecord {
    const task = this.tasks.get(taskId)
    if (!task) throw notFound(t('tasks.notFound'))
    return task
  }

  // Starting.

  /**
   * Starts a task through a library workflow, or through `resolved`, one the user approved on a
   * card, such as a session's agent wrote for this requirement alone.
   */
  async start(
    params: TaskStart,
    from?: { sessionId: string },
    given?: ResolvedWorkflow,
  ): Promise<TaskView> {
    const resolved = given ?? (await this.deps.library.resolve(params.workflowId))
    const projectPath = await this.deps.resolveProject(params.projectPath)
    const first = resolved.workflow.steps[0]!
    if (first.by === 'agent') {
      const pick = this.deps.pickOf(params.agentId, params.options)
      const agent = this.deps.agents().find((a) => a.id === pick.agentId)
      const blocked = blockedFor(agent, pick, first, this.now())
      if (blocked && blocked.kind === 'unusable') {
        throw new HostError(
          'restricted',
          t('tasks.cannotStep', { agent: agent?.name ?? params.agentId }),
        )
      }
    }
    const explicitTitle = params.title?.trim()
    const worktrees = this.deps.worktrees
    const hasWorktree = worktrees && (await this.deps.git.isRepo(projectPath))
    const [title, worktree] = await Promise.all([
      explicitTitle ||
        (from
          ? this.deps.titleTask(from.sessionId, params.text).then((title) => title ?? resolved.name)
          : firstLine(params.text)),
      hasWorktree
        ? worktrees.create(
            projectPath,
            {
              base: params.worktree?.base ?? 'HEAD',
              ...(params.worktree?.branch ? { branch: params.worktree.branch } : {}),
              text: params.text,
            },
            { agentId: params.agentId, options: params.options },
          )
        : null,
    ])
    const now = this.now()
    const task: TaskRecord = {
      id: `t-${this.random().padEnd(12, '0').slice(0, 12)}`,
      projectPath,
      title: title.slice(0, 120),
      text: params.text,
      workflowId: resolved.id,
      workflowName: resolved.name,
      workflowSource: resolved.source,
      workflowHash: resolved.hash,
      workflow: resolved.workflow,
      pace: params.pace,
      paceReason: params.paceReason?.trim() || null,
      first: { agentId: params.agentId, options: { ...params.options } },
      pins: structuredClone(params.pins ?? {}),
      status: 'running',
      end: null,
      rounds: [],
      waiting: [],
      lanes: [{ id: MAIN, parent: null, worktree, base: null, state: 'open', createdAt: now }],
      arrows: {},
      extra: {},
      ahead: {},
      notes: [],
      ending: null,
      needing: false,
      from: from ? { sessionId: from.sessionId } : null,
      pinnedAt: null,
      archivedAt: null,
      unread: false,
      createdAt: now,
      updatedAt: now,
      endedAt: null,
    }
    if (!TASK_ID.test(task.id)) throw new Error('Bad task id')
    return this.locked(() => {
      this.tasks.set(task.id, task)
      this.activate(task, first.id, MAIN, {})
      this.advance(task)
      this.save(task)
      this.pump()
      return this.view(task)
    })
  }

  // The flow.

  /** A step an arrow reached: waiting until its join, its person and a free session allow. */
  private activate(
    task: TaskRecord,
    stepId: string,
    lane: string,
    extra: { sentBack?: SentBack; retryNote?: string | null },
  ): void {
    const existing = task.waiting.find((w) => w.stepId === stepId)
    if (existing) {
      if (!existing.arrivals.includes(lane)) existing.arrivals.push(lane)
      return
    }
    task.waiting.push({
      stepId,
      since: this.now(),
      arrivals: [lane],
      sentBack: extra.sentBack ?? null,
      retryNote: extra.retryNote ?? null,
      blocked: null,
      picker: null,
    })
  }

  /**
   * Whether a step can start: no other live round or waiting step can still reach it, so every
   * branch that leads to it has arrived. `except` are rounds that already reported toward it.
   */
  private joinReady(task: TaskRecord, stepId: string, except: ReadonlySet<string> = new Set()) {
    for (const round of task.rounds) {
      if (!LIVE.has(round.state) || except.has(round.id) || round.stepId === stepId) continue
      if (forwardReach(task.workflow, round.stepId).has(stepId)) return false
    }
    for (const waiting of task.waiting) {
      if (waiting.stepId === stepId) continue
      if (forwardReach(task.workflow, waiting.stepId).has(stepId)) return false
    }
    return true
  }

  /** Who does a step, by the order the design gives; null with why when nobody can yet. */
  private whoFor(
    task: TaskRecord,
    step: WorkflowStep,
    waiting: WaitingRecord,
  ): HeldPick | { blocked: NonNullable<WaitingRecord['blocked']> } {
    const pinned = task.pins[step.id]
    if (pinned) return { by: { ...pinned }, pickedBy: { kind: 'task_pin' }, reason: null }
    const workflowPin = this.deps.library.pins(task.workflowId)[step.id]
    if (workflowPin)
      return { by: { ...workflowPin }, pickedBy: { kind: 'workflow_pin' }, reason: null }
    const previous = task.rounds.findLast((r) => r.stepId === step.id && r.by !== null)
    if (previous?.by) {
      return {
        by: { ...previous.by },
        pickedBy: { kind: 'previous', roundId: previous.id },
        reason: null,
      }
    }
    if (stepIndex(task.workflow, step.id) === 0 && task.rounds.length === 0) {
      return {
        by: this.deps.pickOf(task.first.agentId, task.first.options),
        pickedBy: { kind: 'first' },
        reason: null,
      }
    }
    const held = task.ahead[step.id]
    if (held) return { by: { ...held.by }, pickedBy: { ...held.pickedBy }, reason: held.reason }
    if (waiting.picker) return { blocked: { kind: 'picking', roundId: waiting.picker } }
    return { blocked: { kind: 'no_picker' } }
  }

  /** Moves every waiting step that can go into a round, and holds the rest with why. */
  private advance(task: TaskRecord): void {
    if (task.status !== 'running') return
    const now = this.now()
    const agents = this.deps.agents()
    for (const waiting of [...task.waiting]) {
      if (!this.joinReady(task, waiting.stepId)) {
        waiting.blocked = null
        continue
      }
      const step = stepOf(task.workflow, waiting.stepId)
      if (!step) {
        task.waiting = task.waiting.filter((w) => w !== waiting)
        continue
      }
      const lane = this.laneOfJoin(task, waiting.arrivals)
      const merging = waiting.arrivals.filter((id) => id !== lane)
      const base = {
        id: this.roundId(task),
        stepId: step.id,
        n: task.rounds.filter((r) => r.stepId === step.id).length + 1,
        reason: null,
        sessionId: null,
        lane,
        queuedAt: now,
        startedAt: null,
        endedAt: null,
        outcome: null,
        note: null,
        document: null,
        sentBack: waiting.sentBack,
        retryNote: waiting.retryNote,
        stuck: null,
        asking: false,
        merge: merging.length > 0 ? { lanes: merging, conflicts: [], error: null } : null,
        reminded: false,
        turned: false,
        picks: null,
        reviewShared: false,
      }
      if (step.by === 'you') {
        task.rounds.push({ ...base, state: 'person', by: null, pickedBy: { kind: 'person' } })
        task.waiting = task.waiting.filter((w) => w !== waiting)
        continue
      }
      const who = this.whoFor(task, step, waiting)
      if ('blocked' in who) {
        waiting.blocked = who.blocked
        continue
      }
      const blocked = blockedFor(
        agents.find((a) => a.id === who.by.agentId),
        who.by,
        step,
        now,
      )
      if (blocked) {
        waiting.blocked = blocked
        continue
      }
      // A session sent back works on in the session it had, when that is still there.
      const previous = task.rounds.findLast((r) => r.stepId === step.id && r.sessionId !== null)
      const resume =
        previous?.sessionId &&
        previous.lane === lane &&
        previous.by?.agentId === who.by.agentId &&
        previous.by.model === who.by.model &&
        this.deps.sessions.has(previous.sessionId)
          ? previous.sessionId
          : null
      task.rounds.push({
        ...base,
        state: 'queued',
        by: who.by,
        pickedBy: who.pickedBy,
        reason: who.reason,
        sessionId: resume,
      })
      delete task.ahead[step.id]
      task.waiting = task.waiting.filter((w) => w !== waiting)
    }
    this.armLimitTimer()
  }

  /** The lane a join works in: the nearest one every arriving branch comes from. */
  private laneOfJoin(task: TaskRecord, arrivals: string[]): string {
    if (arrivals.length <= 1) return arrivals[0] ?? MAIN
    const chain = (id: string): string[] => {
      const out: string[] = []
      let at: LaneRecord | undefined = task.lanes.find((l) => l.id === id)
      while (at) {
        out.push(at.id)
        at = at.parent ? task.lanes.find((l) => l.id === at!.parent) : undefined
      }
      return out
    }
    const [head, ...rest] = arrivals.map(chain)
    return head!.find((id) => rest.every((c) => c.includes(id))) ?? MAIN
  }

  private roundId(task: TaskRecord): string {
    return `r${task.rounds.length + 1}-${this.random().slice(0, 6)}`
  }

  /**
   * Starts queued rounds, oldest first, while fewer step sessions work than the host's limit and
   * than a task's own, so one task with parallel branches leaves room for the others.
   */
  private pump(): void {
    if (this.closed) return
    const limit = this.deps.workingLimit?.() ?? DEFAULT_WORKING_STEPS
    let working = 0
    const byTask = new Map<string, number>()
    const queued: { task: TaskRecord; round: RoundRecord }[] = []
    for (const task of this.tasks.values()) {
      if (task.status !== 'running') continue
      for (const round of task.rounds) {
        if (WORKING.has(round.state)) {
          working++
          byTask.set(task.id, (byTask.get(task.id) ?? 0) + 1)
        } else if (round.state === 'queued') queued.push({ task, round })
      }
    }
    queued.sort((a, b) => a.round.queuedAt - b.round.queuedAt)
    for (const { task, round } of queued) {
      if (working >= limit) break
      const own = byTask.get(task.id) ?? 0
      if (own >= MAX_TASK_STEPS) continue
      working++
      byTask.set(task.id, own + 1)
      round.state = 'starting'
      this.save(task)
      void this.launch(task.id, round.id)
    }
  }

  /** Makes the round's folder and session; failures leave it stuck for the user. */
  private async launch(taskId: string, roundId: string): Promise<void> {
    const found = await this.locked(() => this.roundOf(taskId, roundId))
    if (!found || found.round.state !== 'starting') return
    const { task, round } = found
    try {
      const prepared = await this.prepareLane(task, round)
      const merged = await this.mergeArrivals(task, round)
      if (!merged) return
      const lane = task.lanes.find((l) => l.id === round.lane)!
      const where = {
        folder: lane.worktree?.path ?? task.projectPath,
        branch: lane.worktree?.branch ?? null,
      }
      // Before the prompt goes, so what the agent writes counts as this round's.
      round.startedAt = this.now()
      let sessionId = round.sessionId
      if (sessionId && this.deps.sessions.has(sessionId)) {
        this.bySession.set(sessionId, { taskId, roundId })
        // A session made for this round before a restart may never have had its first message.
        const own = !task.rounds.some((r) => r !== round && r.sessionId === sessionId)
        await this.deps.sessions.send(
          sessionId,
          own ? stepPrompt(task, round, where) : againPrompt(task, round, where),
        )
      } else {
        const step = stepOf(task.workflow, round.stepId)!
        const options =
          round.pickedBy.kind === 'first' ? task.first.options : this.deps.optionsOf(round.by!)
        const summary = await this.deps.sessions.createStep({
          agentId: round.by!.agentId,
          projectPath: task.projectPath,
          worktree: lane.worktree,
          prepare: prepared,
          options,
          prompt: stepPrompt(task, round, where),
          title: `${task.title} · ${step.name}`,
          task: { taskId, stepId: round.stepId, roundId },
          ...(step.role === undefined ? {} : { role: step.role }),
        })
        sessionId = summary.id
        round.sessionId = summary.id
        this.bySession.set(summary.id, { taskId, roundId })
      }
      await this.locked(() => {
        if (round.state !== 'starting') {
          // Cancelled, ended or sent back while its session started: it must not work on.
          if (sessionId) void this.deps.sessions.cancel(sessionId).catch(() => {})
          return
        }
        round.state = 'working'
        this.save(task)
        this.stepEvent(task, round, 'started')
      })
    } catch (error) {
      await this.locked(() => {
        if (round.state !== 'starting') return
        this.stick(round, 'start_failed', (error as Error).message)
        this.save(task)
        this.pump()
      })
    }
  }

  private stepEvent(task: TaskRecord, round: RoundRecord, event: 'started' | 'ended'): void {
    const step = stepOf(task.workflow, round.stepId)
    this.deps.events.step?.(event, {
      taskId: task.id,
      title: task.title,
      workflowName: task.workflowName,
      projectPath: task.projectPath,
      stepId: round.stepId,
      stepName: step?.name ?? round.stepId,
      round: round.n,
      agentId: round.by?.agentId ?? null,
      outcome: event === 'ended' ? round.outcome : null,
    })
  }

  /** Makes a parallel branch's worktree when its first step starts; true when it is new. */
  private async prepareLane(task: TaskRecord, round: RoundRecord): Promise<boolean> {
    const lane = task.lanes.find((l) => l.id === round.lane)
    const main = task.lanes.find((l) => l.id === MAIN)!
    if (!lane || lane.id === MAIN)
      return !task.rounds.some((r) => r !== round && r.startedAt !== null)
    if (lane.worktree || !main.worktree || !this.deps.worktrees) return false
    const parent = task.lanes.find((l) => l.id === lane.parent) ?? main
    const base = lane.base ?? (await this.deps.git.head(parent.worktree?.path ?? task.projectPath))
    if (!base) throw new Error(t('tasks.noCommit'))
    const n = task.lanes.filter((l) => l.id.startsWith(`${round.stepId}~`)).length
    lane.worktree = await this.deps.worktrees.create(task.projectPath, {
      base,
      branch: `${main.worktree.branch}-${round.stepId}${n > 1 ? `-${n}` : ''}`,
      text: `${task.title} ${round.stepId}`,
    })
    this.save(task)
    return true
  }

  /** Merges the branches that join at the round into its folder; false when it cannot go on. */
  private async mergeArrivals(task: TaskRecord, round: RoundRecord): Promise<boolean> {
    if (!round.merge || round.merge.lanes.length === 0) return true
    const into = task.lanes.find((l) => l.id === round.lane)
    const folder = into?.worktree?.path ?? task.projectPath
    if (!into?.worktree) {
      round.merge = null
      return true
    }
    for (const laneId of [...round.merge.lanes]) {
      const lane = task.lanes.find((l) => l.id === laneId)
      const branch = lane?.worktree?.branch
      if (!lane || !branch) {
        round.merge.lanes = round.merge.lanes.filter((id) => id !== laneId)
        continue
      }
      const result = (await this.deps.git.contains(folder, branch))
        ? { merged: true, conflicts: [], error: null }
        : await this.deps.git.merge(folder, branch, `Merge ${branch}`)
      if (result.merged) {
        lane.state = 'merged'
        round.merge.lanes = round.merge.lanes.filter((id) => id !== laneId)
        continue
      }
      // The rest merge once the step's agent committed this one.
      round.merge.conflicts = result.conflicts
      round.merge.error = result.error
      if (result.error !== null) {
        this.stick(round, 'merge_failed', result.error)
        this.save(task)
        this.pump()
        return false
      }
      round.merge.lanes = round.merge.lanes.filter((id) => id !== laneId)
      lane.state = 'merged'
      break
    }
    this.save(task)
    return true
  }

  // What a step's session hears.

  sessionCreated(sessionId: string, ref: SessionTaskRef): void {
    this.bySession.set(sessionId, { taskId: ref.taskId, roundId: ref.roundId })
    const found = this.roundOf(ref.taskId, ref.roundId)
    if (!found || found.round.sessionId !== null) return
    found.round.sessionId = sessionId
    // Kept at once, so a restart before the step starts goes on in this session.
    this.save(found.task)
  }

  working(sessionId: string): boolean {
    const found = this.roundOfSession(sessionId)
    return found !== null && (found.round.state === 'working' || found.round.state === 'starting')
  }

  turnEnded(sessionId: string, turn: { byUser: boolean }): void {
    // A turn that answered the user's own message owes no report; only the agent's own turns do.
    if (turn.byUser) return
    void this.locked(() => {
      const found = this.roundOfSession(sessionId)
      if (!found) return
      const { task, round } = found
      if (task.status !== 'running') return
      if (round.state !== 'working' && round.state !== 'picking') return
      const picking = round.state === 'picking'
      if (!round.reminded) {
        round.reminded = true
        this.save(task)
        // Queued behind other messages, it may come after the step already reported or picked.
        const state = round.state
        const due = () =>
          task.status === 'running' &&
          round.state === state &&
          round.reminded &&
          this.roundOfSession(sessionId)?.round === round
        void this.message(sessionId, reminderPrompt(picking), due)
        return
      }
      this.stick(round, picking ? 'no_pick' : 'no_report', null)
      this.save(task)
      this.pump()
    })
  }

  waiting(sessionId: string, waiting: boolean): void {
    void this.locked(() => {
      const found = this.roundOfSession(sessionId)
      if (!found || found.round.asking === waiting) return
      found.round.asking = waiting
      this.save(found.task)
    })
  }

  sessionGone(sessionId: string): void {
    void this.locked(() => {
      const found = this.roundOfSession(sessionId)
      this.bySession.delete(sessionId)
      if (!found) return
      const { task, round } = found
      if (task.status === 'running' && LIVE.has(round.state) && round.state !== 'reviewing') {
        this.stick(round, 'session_gone', null)
      }
      for (const r of task.rounds) if (r.sessionId === sessionId) r.sessionId = null
      this.save(task)
      this.pump()
    })
  }

  // The step's tools.

  /** A step session's report: checked, then the flow moves or it is refused with why. */
  report(sessionId: string, input: ReportInput): Promise<ReportResult> {
    return this.locked(async () => {
      const found = this.roundOfSession(sessionId)
      if (!found) throw new HostError('restricted', 'This session does not work on a workflow step')
      const { task, round } = found
      const step = stepOf(task.workflow, round.stepId)!
      const checks: CheckLine<ReportCheck>[] = []
      const line = (check: ReportCheck, ok: boolean, detail: string | null = null) =>
        checks.push({ check, ok, detail: ok ? null : detail })
      const refused = (): ReportResult => ({
        accepted: false,
        checks,
        next: { kind: 'retry' },
        facts: null,
      })
      if (task.status !== 'running' || (round.state !== 'working' && round.state !== 'starting')) {
        line(
          'step_open',
          false,
          round.state === 'picking'
            ? `Your report was accepted already; call pick_step_agents for ${round.picks?.needed.filter((s) => !round.picks?.made.includes(s)).join(', ')}.`
            : 'This step is not open for a report: it was reported, stopped or the task ended.',
        )
        return refused()
      }
      line('step_open', true)
      const outcome =
        input.outcome === null
          ? step.outcomes.length === 1
            ? step.outcomes[0]!
            : undefined
          : outcomeOf(step, input.outcome)
      const names = step.outcomes.map((o) => `"${o.name}"`).join(', ')
      line('outcome', outcome !== undefined, `Report one of this step's outcomes: ${names}.`)
      const back = outcome ? isBackArrow(task.workflow, step.id, outcome) : false
      const note = input.note?.trim() || null
      const needsNote = step.handIn === 'note' || back
      line(
        'note',
        !needsNote || note !== null,
        back
          ? 'An outcome that sends work back needs a note that says what must change.'
          : 'This step hands in a note: say what you did and how you checked it.',
      )
      let document: RoundRecord['document'] = null
      if (step.handIn === 'document') {
        if (input.artifactId === null) {
          line(
            'document',
            false,
            'This step hands in a document artifact; pass its id as artifact_id.',
          )
        } else {
          const written = await this.deps.documents.written(
            input.artifactId,
            sessionId,
            round.startedAt ?? round.queuedAt,
          )
          if (written.ok) {
            document = {
              artifactId: input.artifactId,
              version: written.version,
              title: written.title,
            }
            line('document', true)
          } else {
            line(
              'document',
              false,
              written.why === 'not_found'
                ? `No artifact ${input.artifactId} exists.`
                : written.why === 'not_document'
                  ? `${input.artifactId} is not a document artifact; write one of type document.`
                  : `This session wrote no version of ${input.artifactId} during this step; write your result into it first.`,
            )
          }
        }
      }
      const lane = task.lanes.find((l) => l.id === round.lane)
      const folder = lane?.worktree?.path ?? null
      const deliverables: StepDeliverable[] = []
      if (input.deliverables && input.deliverables.length > 0) {
        const missing: string[] = []
        for (const item of input.deliverables) {
          if (item.kind === 'link') {
            deliverables.push({ ...item })
            continue
          }
          const file = path.resolve(folder ?? task.projectPath, item.path)
          if (await this.exists(file)) deliverables.push({ ...item, path: file })
          else missing.push(item.path)
        }
        line(
          'deliverables',
          missing.length === 0,
          `These files you hand over are not there: ${missing.join(', ')}. Pass paths that exist, absolute or from your folder.`,
        )
      }
      if (folder && round.merge) {
        const merging = await this.deps.git.merging(folder)
        const conflicts = merging ? await this.deps.git.conflicts(folder) : []
        if (merging || conflicts.length > 0) {
          line(
            'merged',
            false,
            `The merge is not committed yet${conflicts.length > 0 ? `; these files still conflict: ${conflicts.join(', ')}` : ''}. Resolve and commit it.`,
          )
        } else if (round.merge.lanes.length > 0) {
          // The next branch merges now; a conflict there goes back to the agent too.
          const ok = await this.mergeArrivals(task, round)
          const left = round.merge as RoundRecord['merge']
          if (!ok) return refused()
          if (left && left.conflicts.length > 0) {
            line(
              'merged',
              false,
              `The next branch conflicts in: ${left.conflicts.join(', ')}. Resolve and commit that merge too.`,
            )
          } else line('merged', true)
        } else line('merged', true)
      }
      const splits = (outcome?.to.length ?? 0) > 1
      if (folder && (round.lane !== MAIN || splits)) {
        const left = await this.deps.git.uncommitted(folder).catch(() => [])
        line(
          'committed',
          left.length === 0,
          `Commit your changes before reporting; not committed: ${left.slice(0, 10).join(', ')}.`,
        )
      }
      if (checks.some((c) => !c.ok) || !outcome) return refused()

      round.outcome = outcome.name
      round.note = note
      round.document = document
      if (deliverables.length > 0) round.deliverables = deliverables
      else delete round.deliverables
      if (round.merge) round.merge = null
      if (back) {
        const key = arrowKey(step.id, outcome.name)
        const limit = (outcome.limit ?? task.workflow.sendBackLimit) + (task.extra[key] ?? 0)
        if ((task.arrows[key] ?? 0) >= limit) {
          this.stick(round, 'send_back_limit', `${step.name} -> ${outcome.name}`)
          this.save(task)
          this.pump()
          return { accepted: true, checks, next: { kind: 'stuck' }, facts: null }
        }
      }
      const needed = this.picksNeeded(task, round, outcome)
      if (needed.length > 0) {
        round.state = 'picking'
        round.picks = { needed, made: [], refusals: 0 }
        round.reminded = false
        for (const stepId of needed) {
          const waiting = task.waiting.find((w) => w.stepId === stepId)
          if (waiting) waiting.picker = round.id
        }
        this.save(task)
        return {
          accepted: true,
          checks,
          next: { kind: 'pick', steps: needed },
          facts: await this.factsFor(task, needed),
        }
      }
      const next = await this.afterReport(task, round)
      return { accepted: true, checks, next, facts: null }
    })
  }

  /** Who does the next steps, from the agent that reported. */
  pick(sessionId: string, picks: PickInput[]): Promise<PickResult> {
    return this.locked(async () => {
      const found = this.roundOfSession(sessionId)
      if (!found) throw new HostError('restricted', 'This session does not work on a workflow step')
      const { task, round } = found
      if (task.status !== 'running' || round.state !== 'picking' || !round.picks || !round.by) {
        return {
          accepted: false,
          checks: [
            {
              step: round.stepId,
              lines: [{ check: 'step', ok: false, detail: 'Nothing waits for your pick now.' }],
            },
          ],
          next: { kind: 'retry' },
        }
      }
      const owed = round.picks.needed.filter((id) => !round.picks!.made.includes(id))
      const agents = this.deps.agents()
      const allowed = (agent: WorkflowAgent) =>
        this.deps.library.autoPick(agent.id, agent.apiKey).allowed
      const checks: PickResult['checks'] = []
      for (const input of picks) {
        const step = stepOf(task.workflow, input.step)
        if (!step || !owed.includes(input.step)) {
          checks.push({
            step: input.step,
            lines: [
              {
                check: 'step',
                ok: false,
                detail: `Pick only for ${owed.map((id) => `"${id}"`).join(', ')}.`,
              },
            ],
          })
          continue
        }
        const { lines, reviewShared } = checkPick(input, step, task, agents, allowed, this.now())
        checks.push({
          step: input.step,
          lines: [{ check: 'step', ok: true, detail: null }, ...lines],
        })
        if (lines.some((l) => !l.ok)) continue
        task.ahead[step.id] = {
          by: { agentId: input.agent as AgentId, model: input.model, effort: input.effort },
          pickedBy: {
            kind: 'agent',
            stepId: round.stepId,
            roundId: round.id,
            agentId: round.by.agentId,
          },
          reason: input.reason.trim().slice(0, 300) || null,
          roundId: round.id,
        }
        if (reviewShared) round.reviewShared = true
        round.picks.made.push(step.id)
      }
      const refused = checks.some((c) => c.lines.some((l) => !l.ok))
      const still = round.picks.needed.filter((id) => !round.picks!.made.includes(id))
      if (refused) {
        round.picks.refusals++
        if (round.picks.refusals >= MAX_PICK_REFUSALS) {
          this.stick(round, 'picks_refused', null)
          this.save(task)
          this.pump()
          return { accepted: false, checks, next: { kind: 'stuck' } }
        }
      }
      if (still.length > 0) {
        this.save(task)
        return {
          accepted: !refused,
          checks,
          next: refused ? { kind: 'retry' } : { kind: 'pick', steps: still },
        }
      }
      round.picks.refusals = 0
      const next = await this.afterReport(task, round)
      return { accepted: true, checks, next }
    })
  }

  /** The steps the reporting round must pick for: Auto steps its arrow makes ready now. */
  private picksNeeded(task: TaskRecord, round: RoundRecord, outcome: WorkflowOutcome): string[] {
    if (outcome.end !== null || isBackArrow(task.workflow, round.stepId, outcome)) return []
    const candidates: string[] = []
    for (const id of outcome.to) {
      const step = stepOf(task.workflow, id)
      if (!step) continue
      if (step.by === 'agent') {
        candidates.push(id)
        continue
      }
      // Behind a person's step, the agent before it picks ahead for what follows it.
      for (const o of step.outcomes) {
        if (isBackArrow(task.workflow, step.id, o)) continue
        for (const next of o.to)
          if (stepOf(task.workflow, next)?.by === 'agent') candidates.push(next)
      }
    }
    const pins = this.deps.library.pins(task.workflowId)
    const except = new Set([round.id])
    return [...new Set(candidates)].filter((id) => {
      if (task.pins[id] || pins[id] || task.ahead[id]) return false
      if (task.rounds.some((r) => r.stepId === id && r.by !== null)) return false
      return this.joinReady(task, id, except)
    })
  }

  /** After a report and its picks: the user reviews it, or its arrow is followed. */
  private async afterReport(task: TaskRecord, round: RoundRecord): Promise<CheckNext> {
    const step = stepOf(task.workflow, round.stepId)!
    if (step.youReview) {
      round.state = 'reviewing'
      round.endedAt = this.now()
      this.save(task)
      this.pump()
      return { kind: 'review' }
    }
    return this.follow(task, round)
  }

  /** Follows the round's outcome: the next steps, a send back or the task's end. */
  private async follow(task: TaskRecord, round: RoundRecord): Promise<CheckNext> {
    const step = stepOf(task.workflow, round.stepId)!
    const outcome = outcomeOf(step, round.outcome ?? '')!
    round.state = 'done'
    this.stepEvent(task, round, 'ended')
    round.endedAt ??= this.now()
    round.stuck = null
    const key = arrowKey(step.id, outcome.name)
    task.arrows[key] = (task.arrows[key] ?? 0) + 1
    let next: CheckNext
    if (outcome.end !== null) {
      await this.end(task, round, outcome.end)
      next = { kind: 'end', end: outcome.end }
    } else if (isBackArrow(task.workflow, step.id, outcome)) {
      const target = outcome.to[0]!
      this.stopFrom(task, target, round.id)
      this.activate(task, target, round.lane, {
        sentBack: {
          stepId: step.id,
          roundId: round.id,
          outcome: outcome.name,
          note: round.note,
          comments: [],
          by: step.by === 'you' ? 'person' : 'agent',
          count: task.arrows[key]!,
          limit: (outcome.limit ?? task.workflow.sendBackLimit) + (task.extra[key] ?? 0),
        },
      })
      next = { kind: 'start', steps: [target] }
    } else if (outcome.to.length > 1) {
      const parent = task.lanes.find((l) => l.id === round.lane)!
      const base = parent.worktree ? await this.deps.git.head(parent.worktree.path) : null
      for (const target of outcome.to) {
        const id = `${target}~${task.lanes.length}`
        task.lanes.push({
          id,
          parent: parent.id,
          worktree: null,
          base,
          state: 'open',
          createdAt: this.now(),
        })
        this.activate(task, target, id, {})
      }
      next = { kind: 'start', steps: [...outcome.to] }
    } else {
      this.activate(task, outcome.to[0]!, round.lane, {})
      next = { kind: 'start', steps: [...outcome.to] }
    }
    if (task.status === 'running') {
      this.advance(task)
      next = this.nextOf(task, next)
    }
    this.save(task)
    this.pump()
    return next
  }

  /** Says whether the steps an arrow reached start, wait for a join or wait for the user. */
  private nextOf(task: TaskRecord, next: CheckNext): CheckNext {
    if (next.kind !== 'start') return next
    const waiting = next.steps.filter((id) => task.waiting.some((w) => w.stepId === id))
    if (waiting.length === next.steps.length) return { kind: 'wait', steps: next.steps }
    const person = next.steps.filter((id) =>
      task.rounds.some((r) => r.stepId === id && r.state === 'person'),
    )
    if (person.length === next.steps.length) return { kind: 'person', steps: next.steps }
    return next
  }

  /**
   * A send back to `target` stops what came after it: the steps it reaches, their waiting and
   * their parallel branches, which are dropped with their changes when the task ends.
   */
  private stopFrom(task: TaskRecord, target: string, except: string): void {
    const reached = forwardReach(task.workflow, target)
    reached.add(target)
    for (const round of task.rounds) {
      if (round.id === except || !LIVE.has(round.state) || !reached.has(round.stepId)) continue
      this.stopRound(round)
    }
    task.waiting = task.waiting.filter((w) => !reached.has(w.stepId))
    for (const stepId of reached) delete task.ahead[stepId]
    const keep = task.rounds.find((r) => r.id === except)?.lane
    for (const lane of task.lanes) {
      if (lane.id === MAIN || lane.id === keep || lane.state !== 'open') continue
      const users = task.rounds.filter((r) => r.lane === lane.id)
      if (users.every((r) => reached.has(r.stepId))) lane.state = 'abandoned'
    }
  }

  private stopRound(round: RoundRecord): void {
    round.state = 'stopped'
    round.endedAt ??= this.now()
    round.asking = false
    if (round.sessionId) {
      const sessionId = round.sessionId
      void this.deps.sessions.cancel(sessionId).catch(() => {})
    }
  }

  private stick(round: RoundRecord, reason: StuckReason, detail: string | null): void {
    round.state = 'stuck'
    round.stuck = { reason, detail: detail?.slice(0, 2_000) ?? null }
    round.asking = false
  }

  /** Ends the task; a branch that ends it as done merges into the task's own first. */
  private async end(task: TaskRecord, round: RoundRecord, end: TaskEnd): Promise<void> {
    for (const other of task.rounds)
      if (other.id !== round.id && LIVE.has(other.state)) this.stopRound(other)
    task.waiting = []
    task.ahead = {}
    const main = task.lanes.find((l) => l.id === MAIN)!
    const lane = task.lanes.find((l) => l.id === round.lane)
    if (end === 'done' && lane && lane.id !== MAIN && lane.worktree && main.worktree) {
      const result = await this.deps.git.merge(
        main.worktree.path,
        lane.worktree.branch,
        `Merge ${lane.worktree.branch}`,
      )
      if (!result.merged) {
        task.ending = {
          roundId: round.id,
          end,
          lane: lane.id,
          conflicts: result.conflicts,
          error: result.error,
        }
        return
      }
      lane.state = 'merged'
    }
    this.finish(task, end)
  }

  private finish(task: TaskRecord, end: TaskEnd | null): void {
    task.status = end ?? 'cancelled'
    task.end = end
    task.ending = null
    task.endedAt = this.now()
    task.unread = true
    for (const lane of task.lanes)
      if (lane.id !== MAIN && lane.state === 'open') lane.state = 'abandoned'
    void this.cleanLanes(task)
    this.deps.events.attention(summaryOf(task), 'ended')
    this.deliver(task)
  }

  /** Tells the conversation a task started from how it ended. */
  private deliver(task: TaskRecord): void {
    if (!task.from) return
    try {
      this.deps.events.ended?.(this.view(task), task.workflowSource === 'agent')
    } catch (error) {
      this.deps.log('warn', `Could not deliver task ${task.id}: ${(error as Error).message}`)
    }
  }

  /** Removes merged and dropped branch worktrees; the task's own stays with its branch. */
  private async cleanLanes(task: TaskRecord): Promise<void> {
    const worktrees = this.deps.worktrees
    if (!worktrees) return
    for (const lane of task.lanes) {
      if (lane.id === MAIN || !lane.worktree) continue
      if (lane.state !== 'merged' && lane.state !== 'abandoned') continue
      try {
        await worktrees.remove(
          task.projectPath,
          lane.worktree,
          lane.state === 'merged' ? 'delete' : 'keep',
        )
        lane.state = 'removed'
      } catch (error) {
        this.deps.log(
          'warn',
          `Could not remove a task's branch worktree: ${(error as Error).message}`,
        )
      }
    }
    await this.locked(() => this.save(task))
  }

  // What the user does.

  /** Approves what a step handed in, or sends it back to the same step. */
  review(
    taskId: string,
    roundId: string,
    approve: boolean,
    note: string | null,
  ): Promise<TaskView> {
    return this.locked(async () => {
      const { task, round } = this.mustRound(taskId, roundId)
      if (round.state !== 'reviewing') throw new HostError('conflict', t('tasks.notReviewing'))
      if (approve) {
        await this.follow(task, round)
        return this.view(task)
      }
      const text = note?.trim() || null
      const comments = round.document
        ? await this.deps.documents.openComments(round.document.artifactId).catch(() => [])
        : []
      // The next round must have something to fix.
      if (text === null && comments.length === 0) throw invalidParams(t('tasks.sendBackEmpty'))
      const key = arrowKey(round.stepId, null)
      task.arrows[key] = (task.arrows[key] ?? 0) + 1
      round.state = 'done'
      this.stepEvent(task, round, 'ended')
      for (const [stepId, held] of Object.entries(task.ahead)) {
        if (held.roundId === round.id) delete task.ahead[stepId]
      }
      for (const waiting of task.waiting) if (waiting.picker === round.id) waiting.picker = null
      this.activate(task, round.stepId, round.lane, {
        sentBack: {
          stepId: round.stepId,
          roundId: round.id,
          outcome: null,
          note: text,
          comments,
          by: 'person',
          count: task.arrows[key]!,
          limit: task.workflow.sendBackLimit,
        },
      })
      this.advance(task)
      this.save(task)
      this.pump()
      return this.view(task)
    })
  }

  /** The user's answer on a person's step. */
  answer(
    taskId: string,
    roundId: string,
    outcomeName: string,
    note: string | null,
  ): Promise<TaskView> {
    return this.locked(async () => {
      const { task, round } = this.mustRound(taskId, roundId)
      if (round.state !== 'person') throw new HostError('conflict', t('tasks.notPerson'))
      const step = stepOf(task.workflow, round.stepId)!
      const outcome = outcomeOf(step, outcomeName)
      if (!outcome)
        throw invalidParams(t('tasks.noOutcome', { step: step.name, outcome: outcomeName }))
      round.outcome = outcome.name
      round.note = note?.trim() || null
      round.startedAt ??= round.queuedAt
      await this.follow(task, round)
      return this.view(task)
    })
  }

  /** Lets a step that waits for the user go on, with a note for its agent. */
  retry(taskId: string, stepId: string, note: string | null): Promise<TaskView> {
    return this.locked(async () => {
      const task = this.task(taskId)
      if (task.status !== 'running') throw new HostError('conflict', t('tasks.ended'))
      const text = note?.trim() || null
      if (task.ending) {
        const ending = task.ending
        const round = task.rounds.find((r) => r.id === ending.roundId)!
        task.ending = null
        await this.end(task, round, ending.end)
        this.save(task)
        return this.view(task)
      }
      const round = task.rounds.findLast((r) => r.stepId === stepId && r.state === 'stuck')
      if (round?.stuck) {
        const reason = round.stuck.reason
        round.stuck = null
        round.retryNote = text
        if (reason === 'send_back_limit') {
          const step = stepOf(task.workflow, stepId)!
          const key = arrowKey(step.id, round.outcome)
          task.extra[key] = (task.extra[key] ?? 0) + 1
          const outcome = outcomeOf(step, round.outcome ?? '')!
          const needed = this.picksNeeded(task, round, outcome)
          if (needed.length > 0) {
            round.state = 'picking'
            round.picks = { needed, made: [], refusals: 0 }
            if (round.sessionId) void this.message(round.sessionId, reminderPrompt(true))
          } else await this.afterReport(task, round)
        } else if (reason === 'no_report' || reason === 'no_pick' || reason === 'picks_refused') {
          round.state = round.picks ? 'picking' : 'working'
          round.reminded = false
          if (round.picks) round.picks.refusals = 0
          const message = [text, reminderPrompt(round.state === 'picking')]
            .filter(Boolean)
            .join('\n\n')
          if (round.sessionId) void this.message(round.sessionId, message)
        } else {
          // Its session failed or is gone: the same person starts the step again.
          round.state = 'stopped'
          round.endedAt ??= this.now()
          const sessionId =
            round.sessionId && this.deps.sessions.has(round.sessionId) ? round.sessionId : null
          task.rounds.push({
            ...structuredClone(round),
            id: this.roundId(task),
            n: round.n + 1,
            state: 'queued',
            pickedBy: { kind: 'previous', roundId: round.id },
            sessionId: reason === 'merge_failed' ? sessionId : null,
            queuedAt: this.now(),
            startedAt: null,
            endedAt: null,
            outcome: null,
            note: null,
            document: null,
            stuck: null,
            asking: false,
            reminded: false,
            turned: false,
            picks: null,
            retryNote: text,
          })
        }
      } else {
        const waiting = task.waiting.find((w) => w.stepId === stepId)
        if (!waiting) throw new HostError('conflict', t('tasks.nothingToRetry'))
        waiting.blocked = null
        if (text) waiting.retryNote = text
        this.advance(task)
      }
      this.save(task)
      this.pump()
      return this.view(task)
    })
  }

  cancel(taskId: string): Promise<TaskView> {
    return this.locked(() => {
      const task = this.task(taskId)
      if (task.status !== 'running') return this.view(task)
      for (const round of task.rounds) if (LIVE.has(round.state)) this.stopRound(round)
      task.waiting = []
      task.ending = null
      task.status = 'cancelled'
      task.endedAt = this.now()
      this.save(task)
      this.deps.events.attention(summaryOf(task), 'ended')
      this.deliver(task)
      this.pump()
      return this.view(task)
    })
  }

  delete(taskId: string): Promise<void> {
    return this.locked(async () => {
      const task = this.task(taskId)
      if (task.status === 'running') throw new HostError('conflict', t('tasks.stillRunning'))
      this.tasks.delete(taskId)
      const sessions = new Set(task.rounds.flatMap((r) => (r.sessionId ? [r.sessionId] : [])))
      for (const sessionId of sessions) {
        this.bySession.delete(sessionId)
        await this.deps.sessions.delete(sessionId).catch((error: unknown) => {
          this.deps.log('warn', `Could not delete a step's session: ${(error as Error).message}`)
        })
      }
      await this.deps.store.remove(taskId)
      this.deps.events.removed(taskId)
    })
  }

  /** A note for the running steps and every later one; it moves nothing. */
  note(taskId: string, text: string): Promise<TaskView> {
    return this.locked(() => {
      const task = this.task(taskId)
      const clean = text.trim()
      if (!clean) throw invalidParams(t('tasks.noteEmpty'))
      task.notes = [...task.notes, { at: this.now(), text: clean }].slice(-MAX_TASK_NOTES)
      for (const round of task.rounds) {
        if (WORKING.has(round.state) && round.sessionId)
          void this.message(round.sessionId, notePrompt(clean))
      }
      this.save(task)
      return this.view(task)
    })
  }

  /** Who does a step for this task only; a step that waits for someone starts with them. */
  pinStep(taskId: string, stepId: string, pick: StepPick | null): Promise<TaskView> {
    return this.locked(() => {
      const task = this.task(taskId)
      if (!canPinStep(task, stepId)) throw new HostError('conflict', t('tasks.cannotPin'))
      if (pick) task.pins[stepId] = { ...pick }
      else delete task.pins[stepId]
      const waiting = task.waiting.find((w) => w.stepId === stepId)
      if (waiting) waiting.blocked = null
      this.advance(task)
      this.save(task)
      this.pump()
      return this.view(task)
    })
  }

  update(
    taskId: string,
    change: { title?: string; pinned?: boolean; archived?: boolean; unread?: boolean },
  ): Promise<TaskView> {
    return this.locked(() => {
      const task = this.task(taskId)
      if (change.title !== undefined && change.title.trim())
        task.title = change.title.trim().slice(0, 120)
      if (change.pinned !== undefined) task.pinnedAt = change.pinned ? this.now() : null
      if (change.archived !== undefined) task.archivedAt = change.archived ? this.now() : null
      if (change.unread !== undefined) task.unread = change.unread
      this.save(task)
      return this.view(task)
    })
  }

  /** The user changed how many step sessions may work at once. */
  limitChanged(): void {
    void this.locked(() => this.pump())
  }

  /** Plan limits, agents or the host's tools changed: steps held by them may start now. */
  recheck(): void {
    void this.locked(() => {
      for (const task of this.tasks.values()) {
        if (task.status !== 'running') continue
        if (!task.waiting.some((w) => w.blocked && w.blocked.kind !== 'picking')) continue
        this.advance(task)
        this.save(task)
      }
      this.pump()
    })
  }

  // Helpers.

  private async factsFor(task: TaskRecord, stepIds: string[]): Promise<PickFacts> {
    const steps = stepIds.map((id) => stepOf(task.workflow, id)!).filter(Boolean)
    const roles = new Map<string, RoleHint>()
    for (const ref of new Set(steps.flatMap((step) => (step.role ? [step.role] : [])))) {
      const hint = await this.deps.roleHint?.(ref)
      if (hint) roles.set(ref, hint)
    }
    return factsFor(
      task,
      steps,
      this.deps.agents(),
      (agent) => this.deps.library.autoPick(agent.id, agent.apiKey).allowed,
      (stepId) => historyOf(this.tasks.values(), task.workflowId, stepId),
      roles,
    )
  }

  private roundOf(
    taskId: string,
    roundId: string,
  ): { task: TaskRecord; round: RoundRecord } | null {
    const task = this.tasks.get(taskId)
    const round = task?.rounds.find((r) => r.id === roundId)
    return task && round ? { task, round } : null
  }

  private mustRound(taskId: string, roundId: string): { task: TaskRecord; round: RoundRecord } {
    const found = this.roundOf(taskId, roundId)
    if (!found) throw notFound(t('tasks.noStep'))
    return found
  }

  private roundOfSession(sessionId: string): { task: TaskRecord; round: RoundRecord } | null {
    const ref = this.bySession.get(sessionId)
    if (!ref) return null
    const found = this.roundOf(ref.taskId, ref.roundId)
    if (!found) return null
    // A session resumed by a later round of its step answers for that round.
    const latest = found.task.rounds.findLast((r) => r.sessionId === sessionId)
    return latest ? { task: found.task, round: latest } : found
  }

  private async message(sessionId: string, text: string, due?: () => boolean): Promise<void> {
    try {
      await this.deps.sessions.send(sessionId, text, due)
    } catch (error) {
      this.deps.log('warn', `Could not message a step's session: ${(error as Error).message}`)
    }
  }

  /** Steps held by a used-up limit start again when it resets. */
  private armLimitTimer(): void {
    let soonest: number | null = null
    for (const task of this.tasks.values()) {
      for (const waiting of task.waiting) {
        const blocked = waiting.blocked
        if (blocked?.kind === 'limit' && blocked.resetsAt !== null) {
          soonest = soonest === null ? blocked.resetsAt : Math.min(soonest, blocked.resetsAt)
        }
      }
    }
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (soonest === null || this.closed) return
    const delay = Math.min(Math.max(soonest - this.now(), 0) + 5_000, 2 ** 31 - 1)
    this.timer = setTimeout(() => this.recheck(), delay)
    this.timer.unref?.()
  }

  /**
   * Stores the task, tells clients and notifies once each time it starts to need the user. A
   * step's session asking notifies by itself, so that alone does not.
   */
  private save(task: TaskRecord): void {
    task.updatedAt = this.now()
    const needing = needsOf(task).some((need) => need.kind !== 'asking')
    if (needing && !task.needing) {
      task.unread = true
      this.deps.events.attention(summaryOf(task), 'needs-you')
    }
    task.needing = needing
    this.deps.store.put(task).catch((error: unknown) => {
      this.deps.log('error', `Could not store task ${task.id}: ${(error as Error).message}`)
    })
    if (this.tasks.has(task.id)) this.deps.events.changed(this.view(task))
  }
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.trim() || 'Task'
}
