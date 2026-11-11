// The task engine: the only thing that moves a task along its SOP. A task holds tokens, lines of
// work that sit at nodes; a node's run starts once no other token can still reach it, an agent or
// the person reports one of the node's outcomes, and the engine follows that outcome's arrow.

import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { markdownFirstLine } from '@shared/markdown-line'
import { sopGraph, type SopGraph } from '@shared/sop-graph'
import {
  DOCUMENT_CHARS,
  MAX_TASK_SESSIONS,
  NOTE_CHARS,
  REQUIREMENT_CHARS,
  TITLE_CHARS,
  type NodeRunState,
  type NodeRunView,
  type SopNode,
  type TaskDecision,
  type TaskDraft,
  type TaskRetry,
  type TaskState,
  type TaskView,
  type TierSettings,
  type TierState,
} from '@shared/tasks'
import { HostError, invalidParams, notFound } from '../errors'
import { t } from '../i18n'
import type { LogFn, WorktreeRecord } from '../storage'
import type {
  NodeReport,
  NodeRunRecord,
  ReportAnswer,
  TaskEngineApi,
  TaskEvents,
  TaskRecord,
  TaskRuntime,
  TasksFile,
  TokenRecord,
} from './api'
import {
  firstMessage,
  laterMessage,
  reminderMessage,
  REPORT_TOOL,
  type HandedIn,
  type NodeMessage,
} from './prompts'
import { outlineOf } from './sop'
import { emptyTasksFile, type TasksStore } from './store'
import { parseTierSettings, tierAgent, tierState } from './tiers'

export const TITLE_FROM_REQUIREMENT = 80

const STOP = 'Your work on this node is finished: stop working in this session and end your turn.'
const NOT_OPEN: ReportAnswer = {
  ok: false,
  error: `This session has no SOP node waiting for a report now, so there is nothing to report. Do not call \`${REPORT_TOOL}\` again.`,
}

export interface TaskEngineDeps {
  runtime: TaskRuntime
  file: TasksStore
  events: TaskEvents
  log: LogFn
  /** Node sessions working at once; MAX_TASK_SESSIONS by default. */
  maxSessions?: number
}

function newId(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString('hex')}`
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function refuse(error: string): ReportAnswer {
  return { ok: false, error }
}

function isLive(task: TaskRecord): boolean {
  return task.state === 'running' || task.state === 'waiting'
}

function isOpen(run: NodeRunRecord): boolean {
  return run.state === 'queued' || run.state === 'running' || run.state === 'waiting'
}

/** An agent's run that may still report: working, or waiting for the person without an outcome. */
function awaitsReport(run: NodeRunRecord): boolean {
  return (
    run.by === 'agent' &&
    run.outcome === null &&
    (run.state === 'running' || run.state === 'waiting')
  )
}

/** A run whose session holds one of the slots. */
function holdsSlot(run: NodeRunRecord): boolean {
  return (
    run.by === 'agent' &&
    (run.state === 'running' || (run.state === 'waiting' && run.waiting === 'request'))
  )
}

function samePath(a: WorktreeRecord | null | undefined, b: WorktreeRecord | null | undefined) {
  return (a?.path ?? null) === (b?.path ?? null)
}

/** The lanes every token came through alike, outermost first. */
function commonLanes(tokens: readonly TokenRecord[]): WorktreeRecord[] {
  const first = tokens[0]?.lanes ?? []
  let length = first.length
  for (const token of tokens) {
    let at = 0
    while (at < length && at < token.lanes.length && samePath(token.lanes[at], first[at])) at++
    length = at
  }
  return first.slice(0, length)
}

function viewState(task: TaskRecord, runs: readonly NodeRunRecord[]): TaskState {
  if (!isLive(task)) return task.state
  if (runs.some((run) => run.state === 'queued' || run.state === 'running')) return 'running'
  // With no open run at all the engine is between two nodes.
  return runs.some((run) => run.state === 'waiting') ? 'waiting' : 'running'
}

/** The task as clients see it; `runs` are the task's own. */
export function taskView(task: TaskRecord, runs: readonly NodeRunRecord[]): TaskView {
  return {
    id: task.id,
    title: task.title,
    requirement: task.requirement,
    projectPath: task.projectPath,
    sop: { ...task.sop },
    outline: outlineOf(task.snapshot),
    state: viewState(task, runs),
    needsYou: isLive(task) && runs.some((run) => run.state === 'waiting'),
    arrived: [
      ...new Set(task.tokens.filter((token) => token.runId === null).map((token) => token.nodeId)),
    ],
    worktree: task.worktree
      ? { path: task.worktree.path, branch: task.worktree.branch, base: task.worktree.base }
      : null,
    createdBy: task.createdBy,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    endedAt: task.endedAt,
    lastViewedAt: task.lastViewedAt,
  }
}

export function runView(run: NodeRunRecord): NodeRunView {
  return {
    id: run.id,
    taskId: run.taskId,
    nodeId: run.nodeId,
    round: run.round,
    by: run.by,
    state: run.state,
    waiting: run.waiting,
    reason: run.reason,
    sessionId: run.sessionId,
    agentId: run.agentId,
    model: run.model,
    tier: run.tier,
    outcome: run.outcome,
    note: run.note,
    hasDocument: run.document !== null,
    sentBack: run.sentBack && { ...run.sentBack },
    worktree: run.worktree && { path: run.worktree.path, branch: run.worktree.branch },
    startedAt: run.startedAt,
    endedAt: run.endedAt,
  }
}

export class TaskEngine implements TaskEngineApi {
  private data: TasksFile = emptyTasksFile()
  private loaded = false
  /** Each task's work in turn, so a start, a report and a turn's end never interleave. */
  private readonly locks = new Map<string, Promise<void>>()
  private readonly graphs = new Map<string, SopGraph>()
  /** Whether each task needed the person when clients were last told, to notify on the change. */
  private readonly needed = new Map<string, boolean>()
  /** Sessions sent a new round mid-turn: the end of that turn says nothing about the round. */
  private readonly lateTurns = new Set<string>()
  /** What the person wants a retried run told, by run, until it starts. */
  private readonly notes = new Map<string, string>()

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
    for (const task of this.data.tasks) {
      this.needed.set(task.id, this.view(task).needsYou)
      if (isLive(task)) this.queue(task.id, () => this.recover(task))
      else if (task.state !== 'cancelled' && task.spent.length > 0) {
        this.queue(task.id, () => this.sweep(task))
      }
    }
    this.loaded = true
    this.pump()
  }

  /** Brings a task back after a restart: what was cut off is carried on or handed to the person. */
  private async recover(task: TaskRecord): Promise<void> {
    const changed: NodeRunRecord[] = []
    for (const token of task.tokens) {
      const run = token.runId === null ? undefined : this.runOf(token.runId)
      if (token.runId !== null && !(run && isOpen(run))) token.runId = null
    }
    for (const run of this.runsOf(task.id).filter(isOpen)) {
      if (!task.tokens.some((token) => token.runId === run.id)) {
        this.stopRun(task, run, null)
        changed.push(run)
      }
    }
    this.emit(task, ...changed)
    for (const run of this.runsOf(task.id).filter(isOpen)) {
      if (run.waiting === 'stuck' || run.state === 'queued') continue
      // The report was taken and the move cut off.
      if (run.outcome !== null) {
        await this.follow(task, run, run.by === 'person', null)
        continue
      }
      if (run.by === 'person') {
        if (run.toMerge.length > 0) await this.mergeForPerson(task, run)
        continue
      }
      if (run.sessionId === null) {
        this.set(run, 'queued')
        this.emit(task, run)
        continue
      }
      if (!this.rt.alive(run.sessionId)) {
        this.stuck(task, run, t('tasks.reason.sessionClosed', { node: this.nameOf(task, run) }))
        continue
      }
      if (run.state === 'waiting') {
        this.set(run, 'running')
        this.emit(task, run)
      }
      if (!this.rt.working(run.sessionId)) await this.silent(task, run)
    }
    this.settle(task)
  }

  /** Resolves once no task work is in flight; for tests. */
  async idle(): Promise<void> {
    for (let i = 0; i < 1000; i++) {
      await Promise.all(this.locks.values())
      await new Promise((resolve) => setImmediate(resolve))
      if (this.locks.size === 0) return
    }
  }

  // Reads.

  list(): TaskView[] {
    const runs = new Map<string, NodeRunRecord[]>()
    for (const run of this.data.runs) {
      const list = runs.get(run.taskId)
      if (list) list.push(run)
      else runs.set(run.taskId, [run])
    }
    return this.data.tasks.map((task) => taskView(task, runs.get(task.id) ?? []))
  }

  get(taskId: string): { task: TaskView; runs: NodeRunView[] } {
    const task = this.taskOf(taskId)
    const runs = this.runsOf(taskId)
    return { task: taskView(task, runs), runs: runs.map(runView) }
  }

  document(runId: string): string | null {
    return this.runOf(runId)?.document ?? null
  }

  tiers(): TierState {
    return tierState(this.data.tiers, this.rt.agents())
  }

  nodeOf(sessionId: string): { taskId: string; runId: string; nodeId: string } | null {
    const run = this.reportingRun(sessionId)
    return run ? { taskId: run.taskId, runId: run.id, nodeId: run.nodeId } : null
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
    if (typeof draft.sop?.id !== 'string' || typeof draft.sop.source !== 'string') {
      throw invalidParams('The SOP is missing.')
    }
    const { sop, hash } = await this.rt.sop(draft.sop.source, draft.sop.id)
    const now = this.now()
    const task: TaskRecord = {
      id: newId('t'),
      title:
        written ||
        (markdownFirstLine(requirement) || requirement.split('\n')[0]!.trim()).slice(
          0,
          TITLE_FROM_REQUIREMENT,
        ),
      requirement,
      projectPath: draft.projectPath,
      sop: { source: draft.sop.source, id: sop.id, name: sop.name, hash },
      snapshot: sop,
      state: 'running',
      worktree: null,
      tokens: [],
      rounds: {},
      spent: [],
      createdBy: by,
      createdAt: now,
      updatedAt: now,
      endedAt: null,
      lastViewedAt: null,
    }
    task.worktree = await this.rt.createWorktree(task)
    task.tokens.push({
      id: newId('tk'),
      nodeId: sop.start,
      runId: null,
      lanes: task.worktree ? [task.worktree] : [],
      from: null,
    })
    this.data.tasks.push(task)
    this.emit(task)
    this.deps.log('info', `Task ${task.id} created (${sop.id})`)
    await this.withTask(task.id, async () => this.settle(task))
    return this.view(task)
  }

  async cancel(taskId: string): Promise<TaskView> {
    this.taskOf(taskId)
    return this.withTask(taskId, async () => {
      const task = this.taskOf(taskId)
      if (!isLive(task)) return this.view(task)
      const stopped = this.runsOf(taskId).filter(isOpen)
      for (const run of stopped) this.stopRun(task, run, t('tasks.reason.cancelled'))
      task.tokens = []
      task.state = 'cancelled'
      task.endedAt = this.now()
      this.emit(task, ...stopped)
      this.pump()
      return this.view(task)
    })
  }

  async remove(taskId: string): Promise<void> {
    this.taskOf(taskId)
    return this.withTask(taskId, async () => {
      const task = this.taskOf(taskId)
      if (isLive(task)) {
        throw new HostError('conflict', 'Only a task that ended can be removed; cancel it first.')
      }
      for (const run of this.runsOf(taskId)) this.notes.delete(run.id)
      this.data.tasks = this.data.tasks.filter((other) => other !== task)
      this.data.runs = this.data.runs.filter((run) => run.taskId !== taskId)
      this.graphs.delete(taskId)
      this.needed.delete(taskId)
      this.save()
      this.deps.events.removed(taskId)
    })
  }

  async decide(decision: TaskDecision): Promise<TaskView> {
    this.taskOf(decision.taskId)
    const note = this.personNote(decision.note)
    return this.withTask(decision.taskId, async () => {
      const task = this.taskOf(decision.taskId)
      const run = this.runOf(decision.runId)
      if (
        !isLive(task) ||
        run?.taskId !== task.id ||
        run.by !== 'person' ||
        run.waiting !== 'person' ||
        run.outcome !== null
      ) {
        throw new HostError('conflict', 'The node is not waiting for a decision.')
      }
      const node = this.nodeIn(task, run.nodeId)
      const outcome = node.outcomes.find((o) => o.id === decision.outcome)
      if (!outcome) {
        throw invalidParams(
          `"${node.name}" has no outcome ${String(decision.outcome)}; its outcomes are ${node.outcomes.map((o) => o.id).join(', ')}.`,
        )
      }
      // The nodes that start at once begin from the last commit, and nobody is here to make it.
      if (outcome.to.length > 1 && run.worktree && !(await this.rt.clean(run.worktree))) {
        throw new HostError(
          'conflict',
          `Commit the changes in ${run.worktree.path} first: the nodes that start at once begin from its last commit.`,
        )
      }
      run.outcome = outcome.id
      run.note = note
      await this.follow(task, run, true, null)
      return this.view(task)
    })
  }

  async retry(retry: TaskRetry): Promise<TaskView> {
    this.taskOf(retry.taskId)
    const note = this.personNote(retry.note)
    return this.withTask(retry.taskId, async () => {
      const task = this.taskOf(retry.taskId)
      const run = this.runOf(retry.runId)
      if (!isLive(task) || run?.taskId !== task.id || run.waiting !== 'stuck') {
        throw new HostError('conflict', 'The node is not stuck.')
      }
      if (run.outcome !== null) {
        await this.follow(task, run, true, note)
      } else if (run.by === 'person') {
        run.waiting = 'person'
        run.reason = null
        this.emit(task, run)
        await this.mergeForPerson(task, run)
      } else {
        if (note) this.notes.set(run.id, note)
        this.set(run, 'queued')
        run.reminded = false
        this.emit(task, run)
        this.pump()
      }
      return this.view(task)
    })
  }

  markSeen(taskId: string): void {
    const task = this.taskOf(taskId)
    task.lastViewedAt = this.now()
    this.save()
    this.deps.events.changed(this.view(task))
  }

  setTiers(tiers: TierSettings): TierState {
    const parsed = parseTierSettings(tiers)
    if (typeof parsed === 'string') throw invalidParams(parsed)
    this.data.tiers = parsed
    this.save()
    return this.tiers()
  }

  flush(): Promise<void> {
    return this.deps.file.flush()
  }

  // What the host reports of node sessions.

  async report(sessionId: string, report: NodeReport): Promise<ReportAnswer> {
    let known = this.reportingRun(sessionId)
    if (!known) {
      // The session may report before the engine has heard which session it opened.
      await Promise.all(this.locks.values())
      known = this.reportingRun(sessionId)
    }
    if (!known) return NOT_OPEN
    return this.withTask(known.taskId, async (): Promise<ReportAnswer> => {
      const run = this.reportingRun(sessionId)
      const task = run && this.data.tasks.find((other) => other.id === run.taskId)
      const token = task?.tokens.find((other) => other.runId === run?.id)
      if (!run || !task || !token || !isLive(task)) return NOT_OPEN
      const node = this.nodeIn(task, run.nodeId)
      const outcome = node.outcomes.find((o) => o.id === report.outcome)
      if (!outcome) {
        return refuse(
          `"${String(report.outcome)}" is not an outcome of the "${node.name}" node. Report one of: ${node.outcomes.map((o) => `\`${o.id}\` (${o.name})`).join(', ')}.`,
        )
      }
      const note = typeof report.note === 'string' ? report.note.trim() : ''
      if (note === '') {
        return refuse('The note is empty. Say what you did, or the reason for the outcome.')
      }
      if (note.length > NOTE_CHARS) {
        return refuse(`The note is longer than ${NOTE_CHARS} characters. Shorten it.`)
      }
      const document =
        typeof report.document === 'string' && report.document.trim() !== ''
          ? report.document
          : null
      if (node.handIn === 'document' && document === null) {
        return refuse(
          `The "${node.name}" node hands in a document and none was given. Pass it whole as \`document\`, in Markdown.`,
        )
      }
      if (document !== null && document.length > DOCUMENT_CHARS) {
        return refuse(`The document is longer than ${DOCUMENT_CHARS} characters. Shorten it.`)
      }
      const worktree = run.worktree
      if (worktree) {
        try {
          for (const lane of run.toMerge) {
            let merged: boolean
            try {
              merged = await this.rt.merged(worktree, lane)
            } catch (error) {
              // It rejects for a branch that is gone.
              return refuse(
                `Kettu could not check the branch \`${lane.branch}\`, which must be merged into your working folder before you report (${message(error)}).`,
              )
            }
            if (merged) continue
            return refuse(
              `The branch \`${lane.branch}\` is not merged into your working folder yet. Finish the merge under way if there is one, run \`git merge ${lane.branch}\`, resolve the conflicts and commit, then report again.`,
            )
          }
          const why =
            run.toMerge.length > 0
              ? 'A merge is not finished or changes are not committed.'
              : token.lanes.length > 1
                ? 'This node works in a branch of its own, which is merged from its last commit.'
                : outcome.to.length > 1
                  ? 'The nodes this outcome starts each begin from your last commit.'
                  : null
          if (why !== null && !(await this.rt.clean(worktree))) {
            return refuse(`${why} Commit your changes first, then report again.`)
          }
        } catch (error) {
          return refuse(`Kettu could not check your working folder (${message(error)}). Try again.`)
        }
      }
      if (!awaitsReport(run) || !isLive(task)) return NOT_OPEN
      for (const lane of run.toMerge) this.spend(task, lane, true)
      run.toMerge = []
      run.outcome = outcome.id
      run.note = note
      run.document = document
      this.lateTurns.delete(sessionId)
      const next = await this.follow(task, run, false, null)
      return { ok: true, next: `Taken. ${next} ${STOP}` }
    })
  }

  turnEnded(sessionId: string): void {
    // A run that takes this session only later is not what the turn was for.
    const known = this.reportingRun(sessionId)
    if (!known) return
    this.queue(known.taskId, async () => {
      const run = this.reportingRun(sessionId)
      const task = run && this.data.tasks.find((other) => other.id === run.taskId)
      if (!run || !task || run.id !== known.id) return
      if (this.lateTurns.delete(sessionId)) return
      if (run.waiting === 'stuck') return
      if (run.state === 'waiting') {
        this.set(run, 'running')
        this.emit(task, run)
      }
      await this.silent(task, run)
    })
  }

  waiting(sessionId: string, waiting: boolean): void {
    const run = this.reportingRun(sessionId)
    const task = run && this.data.tasks.find((other) => other.id === run.taskId)
    if (!run || !task) return
    if (waiting && run.state === 'running') {
      this.set(run, 'waiting', 'request')
    } else if (!waiting && run.waiting === 'request') {
      this.set(run, 'running')
    } else {
      return
    }
    this.emit(task, run)
  }

  sessionGone(sessionId: string): void {
    this.lateTurns.delete(sessionId)
    const known = this.reportingRun(sessionId)
    if (!known) return
    this.queue(known.taskId, async () => {
      const run = this.reportingRun(sessionId)
      const task = run && this.data.tasks.find((other) => other.id === run.taskId)
      if (!run || !task || run.id !== known.id || run.waiting === 'stuck') return
      this.stuck(task, run, t('tasks.reason.sessionClosed', { node: this.nameOf(task, run) }))
    })
  }

  // Starting nodes.

  /** Starts every node whose waiting tokens no other token can still reach. */
  private settle(task: TaskRecord): void {
    if (!isLive(task)) return
    const { reach } = this.graph(task)
    for (;;) {
      const waiting = task.tokens.filter((token) => token.runId === null)
      const nodeId = waiting
        .map((token) => token.nodeId)
        .find(
          (id) =>
            !task.tokens.some(
              (token) => token.nodeId !== id && (reach[token.nodeId] ?? []).includes(id),
            ),
        )
      if (nodeId === undefined) break
      this.startRun(
        task,
        nodeId,
        waiting.filter((token) => token.nodeId === nodeId),
      )
    }
    this.pump()
  }

  /** Joins the tokens waiting at a node into one run of it. */
  private startRun(task: TaskRecord, nodeId: string, tokens: TokenRecord[]): void {
    const node = this.nodeIn(task, nodeId)
    const lanes = commonLanes(tokens)
    const into = lanes.at(-1) ?? null
    const toMerge: WorktreeRecord[] = []
    for (const token of tokens) {
      const last = token.lanes.at(-1)
      if (last && !samePath(last, into) && !toMerge.some((lane) => samePath(lane, last))) {
        toMerge.push(last)
      }
    }
    const from = (tokens.find((token) => token.from?.back) ?? tokens[0])?.from ?? null
    const person = node.by.kind === 'person'
    const run: NodeRunRecord = {
      id: newId('nr'),
      taskId: task.id,
      nodeId,
      round: this.runsOf(task.id).filter((other) => other.nodeId === nodeId).length + 1,
      by: node.by.kind,
      state: person ? 'waiting' : 'queued',
      waiting: person ? 'person' : null,
      reason: null,
      sessionId: null,
      agentId: null,
      model: null,
      tier: node.by.kind === 'agent' ? node.by.tier : null,
      outcome: null,
      note: null,
      sentBack: from?.back ? { from: from.nodeId, note: from.note } : null,
      startedAt: this.now(),
      endedAt: null,
      document: null,
      worktree: into,
      reminded: false,
      toMerge,
    }
    this.data.runs.push(run)
    task.tokens = task.tokens.filter((token) => !tokens.includes(token))
    task.tokens.push({ id: newId('tk'), nodeId, runId: run.id, lanes, from })
    // What lies between the common lane and a merged one is carried by the merged one.
    for (const token of tokens) this.dropLanes(task, token.lanes.slice(0, -1))
    this.emit(task, run)
    if (person && toMerge.length > 0) this.queue(task.id, () => this.mergeForPerson(task, run))
  }

  /** Fills the free slots with the oldest queued runs. */
  private pump(): void {
    if (!this.loaded) return
    let free = this.maxSessions - this.data.runs.filter(holdsSlot).length
    if (free <= 0) return
    const queued = this.data.runs
      .filter((run) => run.state === 'queued')
      .sort((a, b) => a.startedAt - b.startedAt)
    for (const run of queued) {
      if (free <= 0) break
      const task = this.data.tasks.find((other) => other.id === run.taskId)
      if (!task || !isLive(task)) continue
      free--
      this.set(run, 'running')
      this.emit(task, run)
      this.queue(task.id, () => this.begin(task, run))
    }
  }

  /** Merges what joins at the run, then hands the node to its session, a new one or its own. */
  private async begin(task: TaskRecord, run: NodeRunRecord): Promise<void> {
    if (run.state !== 'running' || run.outcome !== null || !isLive(task)) return
    const node = this.nodeIn(task, run.nodeId)
    try {
      if (!(await this.mergePending(task, run))) return
      const token = task.tokens.find((other) => other.runId === run.id)
      const personNote = this.notes.get(run.id) ?? null
      this.notes.delete(run.id)
      const cameFrom = token?.from && !token.from.back ? token.from : null
      const fromNode = cameFrom && this.nodeIn(task, cameFrom.nodeId)
      const context: NodeMessage = {
        task,
        node,
        round: run.round,
        earlier: this.handedIn(task),
        sentBack: run.sentBack && {
          from: this.nodeIn(task, run.sentBack.from).name,
          note: run.sentBack.note,
        },
        cameFrom: cameFrom &&
          fromNode && {
            from: fromNode.name,
            outcome:
              fromNode.outcomes.find((o) => o.id === cameFrom.outcome)?.name ?? cameFrom.outcome,
            note: cameFrom.note,
          },
        personNote,
        toMerge: run.toMerge,
        worktree: run.worktree,
        inBranch: (token?.lanes.length ?? 0) > 1,
      }
      const earlier = this.sessionFor(task, run)
      if (earlier?.sessionId) {
        const sessionId = earlier.sessionId
        const midTurn = this.rt.working(sessionId)
        try {
          await this.rt.send(sessionId, laterMessage(context))
        } catch (error) {
          this.stuck(
            task,
            run,
            t('tasks.reason.sendFailed', { node: node.name, error: message(error) }),
          )
          return
        }
        if (midTurn) this.lateTurns.add(sessionId)
        run.sessionId = sessionId
        run.agentId = earlier.agentId
        run.model = earlier.model
        this.emit(task, run)
        return
      }
      const tier = node.by.kind === 'agent' ? node.by.tier : 'standard'
      const choice = tierAgent(this.data.tiers, tier, this.rt.agents())
      if (!choice) {
        this.stuck(
          task,
          run,
          t('tasks.reason.noAgent', { node: node.name, tier: t(`tasks.reason.tiers.${tier}`) }),
        )
        return
      }
      run.agentId = choice.agentId
      run.sessionId = null
      run.model = null
      try {
        const opened = await this.rt.openSession({
          task,
          run,
          agentId: choice.agentId,
          options: Object.fromEntries(choice.options.map((option) => [option.id, option.value])),
          prompt: firstMessage(context),
          title: `${task.title} · ${node.name}`,
          worktree: run.worktree,
        })
        run.sessionId = opened.sessionId
        run.model = opened.model
        this.emit(task, run)
      } catch (error) {
        this.stuck(
          task,
          run,
          t('tasks.reason.openFailed', { node: node.name, error: message(error) }),
        )
      }
    } catch (error) {
      this.deps.log('error', `Task ${task.id} could not start ${run.nodeId}: ${message(error)}`)
      this.stuck(task, run, t('tasks.reason.failed', { node: node.name, error: message(error) }))
    }
  }

  /**
   * Merges the lanes that join at the run into its worktree, one after another, and stops at the
   * first that conflicts: that one and the rest stay in `toMerge` for the node's agent. False
   * when a merge could not start, which leaves the run stuck.
   */
  private async mergePending(task: TaskRecord, run: NodeRunRecord): Promise<boolean> {
    const into = run.worktree
    if (!into) {
      run.toMerge = []
      return true
    }
    while (run.toMerge.length > 0) {
      const lane = run.toMerge[0]!
      try {
        if (!(await this.rt.merged(into, lane))) {
          // A merge under way or loose changes: the lanes left are the agent's to merge.
          if (!(await this.rt.clean(into))) return true
          if ((await this.rt.merge(into, lane, true)) === 'conflict') return true
        }
      } catch (error) {
        this.stuck(
          task,
          run,
          t('tasks.reason.mergeFailed', { branch: lane.branch, error: message(error) }),
        )
        return false
      }
      run.toMerge = run.toMerge.slice(1)
      this.spend(task, lane, true)
      this.save()
    }
    return true
  }

  /** A person's node works nowhere, so branches that will not merge are theirs to settle. */
  private async mergeForPerson(task: TaskRecord, run: NodeRunRecord): Promise<void> {
    if (!isLive(task) || run.waiting !== 'person' || run.outcome !== null) return
    if (!(await this.mergePending(task, run))) return
    const lane = run.toMerge[0]
    if (lane && run.worktree) {
      this.stuck(
        task,
        run,
        t('tasks.reason.joinConflict', {
          branch: lane.branch,
          into: run.worktree.branch,
          path: run.worktree.path,
        }),
      )
    } else {
      this.emit(task, run)
    }
  }

  /** The session a round goes back to: the run's own, or the node's previous one. */
  private sessionFor(task: TaskRecord, run: NodeRunRecord): NodeRunRecord | null {
    if (run.sessionId !== null && this.rt.alive(run.sessionId)) return run
    const previous = this.runsOf(task.id).findLast(
      (other) =>
        other !== run &&
        other.nodeId === run.nodeId &&
        other.by === 'agent' &&
        other.sessionId !== null,
    )
    if (!previous?.sessionId || !previous.agentId || !this.rt.alive(previous.sessionId)) return null
    if (!samePath(previous.worktree, run.worktree)) return null
    if (this.data.runs.some((other) => other.sessionId === previous.sessionId && isOpen(other))) {
      return null
    }
    const agent = this.rt.agents().find((other) => other.agentId === previous.agentId)
    return agent?.enabled && agent.canRunNodes ? previous : null
  }

  /** The latest finished run of each node, in the order they finished. */
  private handedIn(task: TaskRecord): HandedIn[] {
    const latest = new Map<string, NodeRunRecord>()
    for (const run of this.runsOf(task.id)) {
      if (run.state !== 'done') continue
      latest.delete(run.nodeId)
      latest.set(run.nodeId, run)
    }
    return [...latest.values()]
      .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
      .map((run) => ({ node: this.nodeIn(task, run.nodeId), run }))
  }

  /** A turn ended without a report: the agent is reminded once, then the person decides. */
  private async silent(task: TaskRecord, run: NodeRunRecord): Promise<void> {
    const node = this.nodeIn(task, run.nodeId)
    if (run.reminded || run.sessionId === null) {
      this.stuck(task, run, t('tasks.reason.noReport', { node: node.name }))
      return
    }
    run.reminded = true
    this.emit(task, run)
    try {
      await this.rt.send(run.sessionId, reminderMessage(node))
    } catch (error) {
      if (!awaitsReport(run)) return
      this.stuck(
        task,
        run,
        t('tasks.reason.sendFailed', { node: node.name, error: message(error) }),
      )
    }
  }

  // Following an outcome.

  /**
   * Follows the outcome a run recorded and says, for the agent, what happens now. Everything
   * that can fail comes first, so the tokens move in one step or the run is left stuck with its
   * outcome kept, for a retry to follow again. `force` takes an arrow back past its limit.
   */
  private async follow(
    task: TaskRecord,
    run: NodeRunRecord,
    force: boolean,
    personNote: string | null,
  ): Promise<string> {
    const node = this.nodeIn(task, run.nodeId)
    const stays = 'The person decides how the task goes on.'
    try {
      const outcome = node.outcomes.find((o) => o.id === run.outcome)
      const token = task.tokens.find((other) => other.runId === run.id)
      if (!outcome || !token) throw new Error('the run has lost its place in the SOP')
      if (outcome.end) return await this.finish(task, run, token, outcome.end)
      const edges = this.graph(task).edges.filter(
        (edge) => edge.from === node.id && edge.outcome === outcome.id,
      )
      const back = edges.filter((edge) => edge.back)
      const key = `${node.id}/${outcome.id}`
      const limit = outcome.rounds ?? task.snapshot.rounds
      if (back.length > 0 && !force && (task.rounds[key] ?? 0) >= limit) {
        this.stuck(
          task,
          run,
          t('tasks.reason.roundsLimit', {
            node: node.name,
            outcome: outcome.name,
            to: back.map((edge) => this.nodeIn(task, edge.to).name).join(', '),
            count: limit,
          }),
        )
        return 'The way back was taken as often as the SOP allows, so the person decides whether it goes back again.'
      }
      const last = token.lanes.at(-1)
      const forks: WorktreeRecord[] = []
      if (outcome.to.length > 1 && last) {
        for (const to of outcome.to) {
          try {
            // The id, not the name: a branch name is made of it.
            forks.push(await this.rt.forkWorktree(task, last, to))
          } catch (error) {
            for (const fork of forks) this.spend(task, fork, false)
            this.stuck(
              task,
              run,
              t('tasks.reason.forkFailed', {
                node: this.nodeIn(task, to).name,
                error: message(error),
              }),
            )
            return stays
          }
        }
      }

      if (back.length > 0) task.rounds[key] = (task.rounds[key] ?? 0) + 1
      const changed = [run]
      for (const edge of back) changed.push(...this.giveUp(task, token, edge.to))
      const note = [run.note ?? '', personNote ? `From the person: ${personNote}` : '']
        .filter(Boolean)
        .join('\n\n')
      task.tokens = task.tokens.filter((other) => other !== token)
      for (const [at, to] of outcome.to.entries()) {
        const fork = forks[at]
        task.tokens.push({
          id: newId('tk'),
          nodeId: to,
          runId: null,
          lanes: fork ? [...token.lanes, fork] : [...token.lanes],
          from: {
            nodeId: node.id,
            outcome: outcome.id,
            note,
            back: back.some((edge) => edge.to === to),
          },
        })
      }
      this.close(run, 'done', null)
      this.emit(task, ...changed)
      this.settle(task)
      const names = outcome.to.map((to) => `"${this.nodeIn(task, to).name}"`)
      if (names.length > 1) {
        return `${names.slice(0, -1).join(', ')} and ${names.at(-1)} start at once.`
      }
      return back.length > 0
        ? `The task goes back to ${names[0]}.`
        : `The task goes on to ${names[0]}.`
    } catch (error) {
      this.deps.log('error', `Task ${task.id} could not move on: ${message(error)}`)
      if (isOpen(run)) {
        this.stuck(task, run, t('tasks.reason.failed', { node: node.name, error: message(error) }))
      }
      return stays
    }
  }

  /** Ends the task by an outcome, once the reporting token's branch is in the task's worktree. */
  private async finish(
    task: TaskRecord,
    run: NodeRunRecord,
    token: TokenRecord,
    end: 'done' | 'dropped',
  ): Promise<string> {
    const own = task.worktree
    const last = token.lanes.at(-1)
    if (own && last && !samePath(own, last)) {
      let result: 'merged' | 'conflict'
      try {
        result = await this.rt.merge(own, last, false)
      } catch (error) {
        this.stuck(
          task,
          run,
          t('tasks.reason.mergeFailed', { branch: last.branch, error: message(error) }),
        )
        return 'The person decides how the task goes on.'
      }
      if (result === 'conflict') {
        this.stuck(
          task,
          run,
          t('tasks.reason.endConflict', { branch: last.branch, into: own.branch }),
        )
        return "Your branch did not merge into the task's branch without conflicts, so the person decides how the task ends."
      }
      this.spend(task, last, true)
    }
    this.close(run, 'done', null)
    const changed = [run]
    for (const other of this.runsOf(task.id).filter(isOpen)) {
      this.stopRun(task, other, t('tasks.reason.ended'))
      changed.push(other)
    }
    const tokens = task.tokens
    task.tokens = []
    for (const other of tokens) this.dropLanes(task, other.lanes)
    task.state = end
    task.endedAt = this.now()
    this.emit(task, ...changed)
    this.rt.notify(this.view(task), 'done')
    this.deps.log('info', `Task ${task.id} ended ${end}`)
    // The cleanup takes its time, and the agent that reported need not wait for it.
    this.queue(task.id, () => this.sweep(task))
    this.pump()
    return end === 'done' ? 'The task is done.' : 'The task ends here, dropped.'
  }

  /**
   * Gives up every other token at a node the way back leads to again: what comes after `nodeId`
   * is done again from it. Returns the runs it stopped.
   */
  private giveUp(task: TaskRecord, moving: TokenRecord, nodeId: string): NodeRunRecord[] {
    const reach = this.graph(task).reach[nodeId] ?? []
    const gone = task.tokens.filter((token) => token !== moving && reach.includes(token.nodeId))
    if (gone.length === 0) return []
    task.tokens = task.tokens.filter((token) => !gone.includes(token))
    const reason = t('tasks.reason.givenUp', { node: this.nodeIn(task, nodeId).name })
    const stopped: NodeRunRecord[] = []
    for (const token of gone) {
      const run = token.runId === null ? undefined : this.runOf(token.runId)
      if (run && isOpen(run)) {
        this.stopRun(task, run, reason)
        stopped.push(run)
      }
      this.dropLanes(task, token.lanes)
    }
    return stopped
  }

  /** Removes the worktrees of branches that were merged or given up, once the task has ended. */
  private async sweep(task: TaskRecord): Promise<void> {
    const own = task.worktree
    for (const entry of [...task.spent]) {
      let merged = entry.merged
      // A branch that was given up with nothing of its own on it leaves nothing to keep. The
      // check rejects for a branch that is gone already.
      if (!merged && own) merged = await this.rt.merged(own, entry.worktree).catch(() => false)
      try {
        await this.rt.removeWorktree(task, entry.worktree, merged)
      } catch (error) {
        this.deps.log('warn', `Could not remove ${entry.worktree.path}: ${message(error)}`)
      }
      task.spent = task.spent.filter((other) => other !== entry)
      this.save()
    }
  }

  // Runs and lanes.

  private set(run: NodeRunRecord, state: 'queued' | 'running'): void
  private set(run: NodeRunRecord, state: 'waiting', waiting: 'request' | 'person'): void
  private set(run: NodeRunRecord, state: NodeRunState, waiting?: 'request' | 'person'): void {
    run.state = state
    run.waiting = waiting ?? null
    run.reason = null
  }

  private close(run: NodeRunRecord, state: 'done' | 'stopped', reason: string | null): void {
    run.state = state
    run.waiting = null
    run.reason = reason
    run.endedAt = this.now()
    this.notes.delete(run.id)
  }

  /** Leaves a run to the person, with why; its slot is free for another. */
  private stuck(task: TaskRecord, run: NodeRunRecord, reason: string): void {
    run.state = 'waiting'
    run.waiting = 'stuck'
    run.reason = reason
    this.emit(task, run)
    this.pump()
  }

  /** Ends a run without a report; the branches it was still to merge are given up with it. */
  private stopRun(task: TaskRecord, run: NodeRunRecord, reason: string | null): void {
    const inTurn = holdsSlot(run) && run.sessionId !== null
    this.close(run, 'stopped', reason)
    for (const lane of run.toMerge) this.spend(task, lane, false)
    run.toMerge = []
    if (inTurn && run.sessionId !== null) {
      const sessionId = run.sessionId
      this.lateTurns.delete(sessionId)
      this.rt.stop(sessionId).catch((error: unknown) => {
        this.deps.log('warn', `Could not stop task session ${sessionId}: ${message(error)}`)
      })
    }
  }

  private spend(task: TaskRecord, worktree: WorktreeRecord, merged: boolean): void {
    const entry = task.spent.find((other) => samePath(other.worktree, worktree))
    if (entry) entry.merged ||= merged
    else task.spent.push({ worktree, merged })
  }

  /** Gives up the lanes no token works in or came through any more, the task's own excepted. */
  private dropLanes(task: TaskRecord, lanes: readonly WorktreeRecord[]): void {
    for (const lane of lanes) {
      if (samePath(lane, task.worktree)) continue
      if (task.tokens.some((token) => token.lanes.some((other) => samePath(other, lane)))) continue
      this.spend(task, lane, false)
    }
  }

  // Lookups.

  private graph(task: TaskRecord): SopGraph {
    let graph = this.graphs.get(task.id)
    if (!graph) {
      graph = sopGraph(task.snapshot)
      this.graphs.set(task.id, graph)
    }
    return graph
  }

  private nodeIn(task: TaskRecord, nodeId: string): SopNode {
    const node = task.snapshot.nodes.find((other) => other.id === nodeId)
    if (!node) throw new Error(`the SOP has no node ${nodeId}`)
    return node
  }

  private nameOf(task: TaskRecord, run: NodeRunRecord): string {
    return task.snapshot.nodes.find((node) => node.id === run.nodeId)?.name ?? run.nodeId
  }

  private taskOf(taskId: string): TaskRecord {
    const task = this.data.tasks.find((other) => other.id === taskId)
    if (!task) throw notFound(`No task ${taskId}.`)
    return task
  }

  private runOf(runId: string): NodeRunRecord | undefined {
    return this.data.runs.find((run) => run.id === runId)
  }

  private runsOf(taskId: string): NodeRunRecord[] {
    return this.data.runs.filter((run) => run.taskId === taskId)
  }

  private reportingRun(sessionId: string): NodeRunRecord | undefined {
    return this.data.runs.find((run) => run.sessionId === sessionId && awaitsReport(run))
  }

  private personNote(value: unknown): string | null {
    if (value !== undefined && typeof value !== 'string')
      throw invalidParams('The note is not text.')
    const note = value?.trim() || null
    if (note && note.length > NOTE_CHARS) {
      throw invalidParams(`The note is longer than ${NOTE_CHARS} characters.`)
    }
    return note
  }

  private view(task: TaskRecord): TaskView {
    return taskView(task, this.runsOf(task.id))
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

  /** Work nobody waits for, in the task's turn. */
  private queue(taskId: string, work: () => Promise<void>): void {
    this.withTask(taskId, work).catch((error: unknown) => {
      this.deps.log('error', `Task ${taskId}: ${message(error)}`)
    })
  }

  private save(): void {
    this.deps.file.save(this.data)
  }

  /** Stores and tells clients: the runs that changed, then their task, whose view follows them. */
  private emit(task: TaskRecord, ...runs: NodeRunRecord[]): void {
    task.updatedAt = this.now()
    this.save()
    for (const run of runs) this.deps.events.run(runView(run))
    const view = this.view(task)
    this.deps.events.changed(view)
    const was = this.needed.get(task.id) ?? false
    this.needed.set(task.id, view.needsYou)
    if (view.needsYou && !was) this.rt.notify(view, 'needs-you')
  }
}

export function createTaskEngine(deps: TaskEngineDeps): TaskEngine {
  return new TaskEngine(deps)
}
