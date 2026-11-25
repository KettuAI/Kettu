// What clients see of a task: its sidebar summary, its full view and what waits for the person.

import {
  isBackArrow,
  stepIndex,
  type ArrowView,
  type RoundState,
  type RoundView,
  type StepState,
  type TaskDeliverable,
  type TaskNeed,
  type TaskStepSummary,
  type TaskSummary,
  type TaskView,
  type WaitingView,
} from '@shared/workflow'
import type { AgentId, TaskDeliveryEntry } from '@shared/thread'
import { arrowKey, stepOf } from './graph'
import type { LaneRecord, RoundRecord, TaskRecord } from './model'

/** Rounds that still belong to the flow: they can go on, so a join waits for them. */
export const LIVE: ReadonlySet<RoundState> = new Set([
  'queued',
  'starting',
  'working',
  'picking',
  'reviewing',
  'person',
  'stuck',
])

/** Rounds whose session works now, which the limit on working sessions counts. */
export const WORKING: ReadonlySet<RoundState> = new Set(['starting', 'working', 'picking'])

export function laneOf(task: TaskRecord, laneId: string): LaneRecord | undefined {
  return task.lanes.find((lane) => lane.id === laneId)
}

function latestRound(task: TaskRecord, stepId: string): RoundRecord | undefined {
  return task.rounds.findLast((round) => round.stepId === stepId)
}

function stepState(task: TaskRecord, stepId: string): StepState {
  const waiting = task.waiting.find((w) => w.stepId === stepId)
  const round = latestRound(task, stepId)
  if (waiting && (!round || !LIVE.has(round.state))) {
    if (waiting.blocked && waiting.blocked.kind !== 'picking') return 'needs_you'
    return 'waiting'
  }
  if (!round) return 'not_reached'
  if (task.ending?.roundId === round.id) return task.ending.conflicts.length > 0 ? 'error' : 'done'
  switch (round.state) {
    case 'queued':
      return 'waiting'
    case 'starting':
    case 'working':
    case 'picking':
      return round.asking || round.limited ? 'needs_you' : 'running'
    case 'reviewing':
    case 'person':
      return 'needs_you'
    case 'stuck':
      return 'error'
    case 'done':
      return 'done'
    case 'stopped':
      return 'not_reached'
  }
}

export function needsOf(task: TaskRecord): TaskNeed[] {
  if (task.status !== 'running') return []
  const needs: TaskNeed[] = []
  for (const round of task.rounds) {
    if (round.state === 'person') {
      needs.push({ kind: 'person', stepId: round.stepId, roundId: round.id })
    } else if (round.state === 'reviewing') {
      needs.push({ kind: 'review', stepId: round.stepId, roundId: round.id })
    } else if (round.state === 'stuck' && round.stuck) {
      needs.push({
        kind: 'stuck',
        stepId: round.stepId,
        roundId: round.id,
        reason: round.stuck.reason,
        detail: round.stuck.detail,
      })
    } else if (WORKING.has(round.state) && round.limited) {
      needs.push({ kind: 'blocked', stepId: round.stepId, reason: { ...round.limited } })
    } else if (WORKING.has(round.state) && round.asking && round.sessionId) {
      needs.push({
        kind: 'asking',
        stepId: round.stepId,
        roundId: round.id,
        sessionId: round.sessionId,
      })
    }
  }
  for (const waiting of task.waiting) {
    if (waiting.blocked && waiting.blocked.kind !== 'picking') {
      needs.push({ kind: 'blocked', stepId: waiting.stepId, reason: waiting.blocked })
    }
  }
  if (task.ending && (task.ending.conflicts.length > 0 || task.ending.error !== null)) {
    const round = task.rounds.find((r) => r.id === task.ending!.roundId)
    needs.push({
      kind: 'end_merge',
      stepId: round?.stepId ?? '',
      conflicts: [...task.ending.conflicts],
      error: task.ending.error,
    })
  }
  return needs
}

export function summaryOf(task: TaskRecord): TaskSummary {
  const steps: TaskStepSummary[] = task.workflow.steps.map((step) => {
    const rounds = task.rounds.filter((round) => round.stepId === step.id)
    const last = rounds.at(-1)
    return {
      id: step.id,
      name: step.name,
      state: stepState(task, step.id),
      rounds: rounds.length,
      agentId: last?.by?.agentId ?? null,
      sessionId: last?.sessionId ?? null,
      startedAt: rounds[0]?.startedAt ?? null,
      endedAt: last?.endedAt ?? null,
    }
  })
  const started = task.rounds.map((round) => stepIndex(task.workflow, round.stepId))
  const needs = needsOf(task)
  const agents: AgentId[] = []
  for (const round of task.rounds) {
    if (round.by && !agents.includes(round.by.agentId)) agents.push(round.by.agentId)
  }
  const main = laneOf(task, 'main')
  return {
    id: task.id,
    projectPath: task.projectPath,
    title: task.title,
    workflowId: task.workflowId,
    workflowName: task.workflowName,
    status: task.status,
    end: task.end,
    steps,
    at: started.length > 0 ? Math.max(...started) + 1 : null,
    needsYou: needs.length > 0,
    needKinds: [...new Set(needs.map((need) => need.kind))],
    error: needs.some((need) => need.kind === 'stuck' || need.kind === 'end_merge'),
    running: task.rounds.some(
      (round) => (WORKING.has(round.state) && !round.limited) || round.state === 'queued',
    ),
    branch: main?.worktree?.branch ?? null,
    worktreePath: main?.worktree?.path ?? null,
    agents,
    pinnedAt: task.pinnedAt,
    archivedAt: task.archivedAt,
    unread: task.unread,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    endedAt: task.endedAt,
    from: task.from ? { ...task.from } : null,
  }
}

function roundView(task: TaskRecord, round: RoundRecord): RoundView {
  const lane = laneOf(task, round.lane)
  return {
    id: round.id,
    stepId: round.stepId,
    n: round.n,
    state: round.state,
    by: round.by ? { ...round.by } : null,
    pickedBy: { ...round.pickedBy },
    reason: round.reason,
    sessionId: round.sessionId,
    branch: lane?.worktree?.branch ?? null,
    queuedAt: round.queuedAt,
    startedAt: round.startedAt,
    endedAt: round.endedAt,
    outcome: round.outcome,
    note: round.note,
    document: round.document ? { ...round.document } : null,
    deliverables: (round.deliverables ?? []).map((item) => ({ ...item })),
    sentBack: round.sentBack ? structuredClone(round.sentBack) : null,
    stuck: round.stuck ? { ...round.stuck } : null,
    asking: round.asking,
    merge: round.merge
      ? {
          branches: round.merge.lanes.map((id) => laneOf(task, id)?.worktree?.branch ?? id),
          conflicts: [...round.merge.conflicts],
          error: round.merge.error,
        }
      : null,
  }
}

function arrowsOf(task: TaskRecord): ArrowView[] {
  const views: ArrowView[] = []
  for (const step of task.workflow.steps) {
    for (const outcome of step.outcomes) {
      const taken = task.arrows[arrowKey(step.id, outcome.name)] ?? 0
      const back = isBackArrow(task.workflow, step.id, outcome)
      if (taken === 0 && !back) continue
      views.push({
        from: step.id,
        outcome: outcome.name,
        to: [...outcome.to],
        back,
        taken,
        limit: back ? (outcome.limit ?? task.workflow.sendBackLimit) : null,
      })
    }
    if (step.youReview) {
      views.push({
        from: step.id,
        outcome: '',
        to: [step.id],
        back: true,
        taken: task.arrows[arrowKey(step.id, null)] ?? 0,
        limit: task.workflow.sendBackLimit,
      })
    }
  }
  return views
}

function waitingView(task: TaskRecord): WaitingView[] {
  return task.waiting.map((waiting) => {
    const held = task.ahead[waiting.stepId]
    return {
      stepId: waiting.stepId,
      since: waiting.since,
      blocked: waiting.blocked ? structuredClone(waiting.blocked) : null,
      pick: held
        ? { by: { ...held.by }, pickedBy: { ...held.pickedBy }, reason: held.reason }
        : null,
    }
  })
}

/**
 * What a task delivered: the pull requests of its steps' sessions, then for each step in the
 * workflow's order the files and links its latest report handed over, then the documents they
 * handed in, each document once at its latest version.
 */
export function deliverablesOf(
  task: TaskRecord,
  pullRequests: readonly string[],
): TaskDeliverable[] {
  const out: TaskDeliverable[] = []
  const seen = new Set<string>()
  const add = (key: string, item: TaskDeliverable) => {
    if (seen.has(key)) return
    seen.add(key)
    out.push(item)
  }
  for (const url of pullRequests) add(`pr:${url}`, { kind: 'pull_request', url })
  const reported = task.workflow.steps.flatMap((step) => {
    const round = task.rounds.findLast((r) => r.stepId === step.id && r.outcome !== null)
    return round ? [round] : []
  })
  for (const round of reported) {
    for (const item of round.deliverables ?? []) {
      add(item.kind === 'file' ? `file:${item.path}` : `link:${item.url}`, { ...item })
    }
  }
  const documents = new Map<string, Extract<TaskDeliverable, { kind: 'document' }>>()
  for (const round of reported) {
    const doc = round.document
    if (!doc) continue
    const known = documents.get(doc.artifactId)
    if (known && known.version >= doc.version) continue
    // A later version moves the document to where its step stands.
    documents.delete(doc.artifactId)
    documents.set(doc.artifactId, { kind: 'document', ...doc })
  }
  for (const doc of documents.values()) add(`doc:${doc.artifactId}`, doc)
  return out
}

export function viewOf(task: TaskRecord, pullRequests: readonly string[] = []): TaskView {
  return {
    ...summaryOf(task),
    text: task.text,
    pace: task.pace,
    paceReason: task.paceReason,
    workflow: structuredClone(task.workflow),
    workflowHash: task.workflowHash,
    pins: structuredClone(task.pins),
    notes: task.notes.map((note) => ({ ...note })),
    rounds: task.rounds.map((round) => roundView(task, round)),
    waiting: waitingView(task),
    arrows: arrowsOf(task),
    needs: needsOf(task),
    from: task.from ? { ...task.from } : null,
    deliverables: deliverablesOf(task, pullRequests),
  }
}

/** A step's round whose work a used-up plan limit stopped, which someone pinned may take over. */
export function heldWorking(round: RoundRecord): boolean {
  return round.state === 'working' && !!round.limited
}

/**
 * Whether a step's agent may be pinned for this task: it has not started, waits blocked, or its
 * work waits for a plan limit.
 */
export function canPinStep(task: TaskRecord, stepId: string): boolean {
  const step = stepOf(task.workflow, stepId)
  if (step?.by !== 'agent') return false
  return !task.rounds.some(
    (round) => round.stepId === stepId && LIVE.has(round.state) && !heldWorking(round),
  )
}

/**
 * What the conversation a task started from is told when it ends: how, the steps that ran, how
 * long it took and what it delivered; `writtenBy` is the agent that wrote its workflow for it.
 */
export function deliveryOf(
  view: TaskView,
  writtenBy: AgentId | null,
  now: number,
): Omit<TaskDeliveryEntry, 'kind' | 'id' | 'after'> {
  const ran = new Set(
    view.rounds.filter((r) => r.startedAt !== null || r.outcome !== null).map((r) => r.stepId),
  )
  const status = view.status === 'running' ? 'cancelled' : view.status
  return {
    taskId: view.id,
    title: view.title,
    status,
    steps: ran.size,
    durationMs: Math.max(0, (view.endedAt ?? now) - view.createdAt),
    deliverables: (view.deliverables ?? []).map((item) => ({ ...item })),
    written: writtenBy && status === 'done' ? { agentId: writtenBy } : null,
  }
}
