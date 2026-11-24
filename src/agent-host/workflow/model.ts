// A task as the agent host keeps it in the thread database, and the database calls on it. Only the
// host writes these records; the check on reading guards what the engine relies on.

import { isAgentId } from '@shared/agents'
import {
  DELIVERABLE_DETAIL_CHARS,
  DELIVERABLE_PATH_CHARS,
  DELIVERABLE_TITLE_CHARS,
  DELIVERABLE_URL_CHARS,
  MAX_STEP_DELIVERABLES,
  isPace,
  isPickedBy,
  isStepPick,
  type BlockedReason,
  type Pace,
  type PickedBy,
  type RoundState,
  type SentBack,
  type StepDeliverable,
  type Workflow,
  type WorkflowSource,
  type StepPick,
  type StuckReason,
  type TaskEnd,
  type TaskNote,
  type TaskStatus,
} from '@shared/workflow'
import type { AgentId } from '@shared/thread'
import type { WorktreeRecord } from '../storage'

export const TASK_ID = /^t-[0-9a-f]{12}$/

/** Where steps work: the task's own folder, or a parallel branch's worktree. */
export interface LaneRecord {
  id: string // 'main' for the task's own
  parent: string | null
  /** Null outside Git, where every step works in the project folder, and until it is made. */
  worktree: WorktreeRecord | null
  /** The commit a parallel branch's worktree is cut from when its first step starts. */
  base: string | null
  state: 'open' | 'merged' | 'abandoned' | 'removed'
  createdAt: number
}

/** A pick held for a step that has not started: made by an agent ahead of it. */
export interface HeldPick {
  by: StepPick
  pickedBy: PickedBy
  reason: string | null
}

export interface RoundRecord {
  id: string
  stepId: string
  n: number
  state: RoundState
  by: StepPick | null
  pickedBy: PickedBy
  reason: string | null
  sessionId: string | null
  lane: string
  queuedAt: number
  startedAt: number | null
  endedAt: number | null
  outcome: string | null
  note: string | null
  document: { artifactId: string; version: number; title: string } | null
  /** Files and links its report handed over; a record stored before them has none. */
  deliverables?: StepDeliverable[]
  sentBack: SentBack | null
  /** The person's note when they retried it. */
  retryNote: string | null
  stuck: { reason: StuckReason; detail: string | null } | null
  asking: boolean
  /** Lanes still to merge into its folder at a join, the files in conflict, or why it failed. */
  merge: { lanes: string[]; conflicts: string[]; error: string | null } | null
  /** It was reminded once to report or pick after a turn ended without it. */
  reminded: boolean
  /** A turn started in its session since it began or was reminded. */
  turned: boolean
  /** The steps its agent picks for, those picked, and the picks refused in a row. */
  picks: { needed: string[]; made: string[]; refusals: number } | null
  /** The step's review that its pick may share an agent and model with, as the only choice. */
  reviewShared: boolean
}

/** A step activated by an arrow that has not started: at a join, for a pick, or blocked. */
export interface WaitingRecord {
  stepId: string
  since: number
  /** The lanes it was reached from, in order; more than one at a join. */
  arrivals: string[]
  sentBack: SentBack | null
  retryNote: string | null
  blocked: BlockedReason | null
  /** The round whose agent picks who does it, while it has not. */
  picker: string | null
}

export interface TaskRecord {
  id: string
  projectPath: string
  title: string
  text: string
  workflowId: string
  workflowName: string
  /** `official` for a workflow that shipped with Kettu before v0.1.2; no new task gets it. */
  workflowSource: WorkflowSource | 'official'
  workflowHash: string
  /** Locked when the task started. */
  workflow: Workflow
  pace: Pace
  paceReason: string | null
  /** The first step's agent and the tray's option values for it. */
  first: { agentId: AgentId; options: Record<string, string | boolean> }
  pins: Record<string, StepPick>
  status: TaskStatus
  end: TaskEnd | null
  rounds: RoundRecord[]
  waiting: WaitingRecord[]
  lanes: LaneRecord[]
  /** Times each arrow was taken, by `step/outcome`; a review sent back counts as `step#review`. */
  arrows: Record<string, number>
  /** Trips Retry allowed past an arrow back's limit. */
  extra: Record<string, number>
  /** Picks made ahead of steps that start later, as behind a person's step or a review. */
  ahead: Record<string, HeldPick & { roundId: string | null }>
  notes: TaskNote[]
  /** An end that waits on merging its branch into the task's folder. */
  ending: {
    roundId: string
    end: TaskEnd
    lane: string
    conflicts: string[]
    error: string | null
  } | null
  /** It needed the person when last looked at, so a notification went out. */
  needing: boolean
  from: { sessionId: string } | null
  pinnedAt: number | null
  archivedAt: number | null
  unread: boolean
  createdAt: number
  updatedAt: number
  endedAt: number | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const isString = (value: unknown): value is string => typeof value === 'string'
const isTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
const isNullableTime = (value: unknown): value is number | null => value === null || isTime(value)
const isNullableString = (value: unknown): value is string | null =>
  value === null || isString(value)
const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isString)
const isCountMap = (value: unknown): value is Record<string, number> =>
  isRecord(value) &&
  Object.values(value).every((n) => Number.isSafeInteger(n) && (n as number) >= 0)

const ROUND_STATES: ReadonlySet<unknown> = new Set<RoundState>([
  'queued',
  'starting',
  'working',
  'picking',
  'reviewing',
  'person',
  'stuck',
  'done',
  'stopped',
])
const STATUSES: ReadonlySet<unknown> = new Set<TaskStatus>([
  'running',
  'done',
  'dropped',
  'cancelled',
])
const SOURCES: ReadonlySet<unknown> = new Set<TaskRecord['workflowSource']>([
  'official',
  'github',
  'file',
  'agent',
  'user',
  'community',
])
const LANE_STATES: ReadonlySet<unknown> = new Set(['open', 'merged', 'abandoned', 'removed'])

function isWorktree(value: unknown): value is WorktreeRecord {
  return (
    isRecord(value) &&
    isString(value.path) &&
    isString(value.branch) &&
    isString(value.base) &&
    isString(value.baseOid)
  )
}

function isSentBack(value: unknown): value is SentBack {
  return (
    isRecord(value) &&
    isString(value.stepId) &&
    isString(value.roundId) &&
    isNullableString(value.outcome) &&
    isNullableString(value.note) &&
    isStringList(value.comments) &&
    (value.by === 'agent' || value.by === 'person') &&
    Number.isSafeInteger(value.count) &&
    Number.isSafeInteger(value.limit)
  )
}

function isBlocked(value: unknown): value is BlockedReason {
  if (!isRecord(value)) return false
  switch (value.kind) {
    case 'limit':
      return isAgentId(value.agentId) && isNullableTime(value.resetsAt)
    case 'unusable':
      return isAgentId(value.agentId) && isString(value.why)
    case 'tools':
      return isStringList(value.missing)
    case 'no_agent':
    case 'no_picker':
      return true
    case 'picking':
      return isString(value.roundId)
    default:
      return false
  }
}

function isLane(value: unknown): value is LaneRecord {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isNullableString(value.parent) &&
    (value.worktree === null || isWorktree(value.worktree)) &&
    isNullableString(value.base) &&
    LANE_STATES.has(value.state) &&
    isTime(value.createdAt)
  )
}

/** A file or link as `report_step` stores it, which only the host writes. */
export function isStepDeliverable(value: unknown): value is StepDeliverable {
  if (!isRecord(value)) return false
  const { kind, title, detail } = value
  if (!isString(title) || title.length === 0 || title.length > DELIVERABLE_TITLE_CHARS) return false
  if (!(detail === null || (isString(detail) && detail.length <= DELIVERABLE_DETAIL_CHARS)))
    return false
  if (kind === 'file') return isString(value.path) && value.path.length <= DELIVERABLE_PATH_CHARS
  if (kind === 'link') {
    return (
      isString(value.url) &&
      value.url.length <= DELIVERABLE_URL_CHARS &&
      /^https?:\/\//i.test(value.url)
    )
  }
  return false
}

function isRound(value: unknown): value is RoundRecord {
  if (!isRecord(value)) return false
  const doc = value.document
  const stuck = value.stuck
  const merge = value.merge
  const picks = value.picks
  return (
    isString(value.id) &&
    isString(value.stepId) &&
    Number.isSafeInteger(value.n) &&
    ROUND_STATES.has(value.state) &&
    (value.by === null || isStepPick(value.by)) &&
    isPickedBy(value.pickedBy) &&
    isNullableString(value.reason) &&
    isNullableString(value.sessionId) &&
    isString(value.lane) &&
    isTime(value.queuedAt) &&
    isNullableTime(value.startedAt) &&
    isNullableTime(value.endedAt) &&
    isNullableString(value.outcome) &&
    isNullableString(value.note) &&
    (doc === null ||
      (isRecord(doc) &&
        isString(doc.artifactId) &&
        Number.isSafeInteger(doc.version) &&
        isString(doc.title))) &&
    (value.deliverables === undefined ||
      (Array.isArray(value.deliverables) &&
        value.deliverables.length <= MAX_STEP_DELIVERABLES &&
        value.deliverables.every(isStepDeliverable))) &&
    (value.sentBack === null || isSentBack(value.sentBack)) &&
    isNullableString(value.retryNote) &&
    (stuck === null ||
      (isRecord(stuck) && isString(stuck.reason) && isNullableString(stuck.detail))) &&
    typeof value.asking === 'boolean' &&
    (merge === null ||
      (isRecord(merge) &&
        isStringList(merge.lanes) &&
        isStringList(merge.conflicts) &&
        isNullableString(merge.error))) &&
    typeof value.reminded === 'boolean' &&
    typeof value.turned === 'boolean' &&
    (picks === null ||
      (isRecord(picks) &&
        isStringList(picks.needed) &&
        isStringList(picks.made) &&
        Number.isSafeInteger(picks.refusals))) &&
    typeof value.reviewShared === 'boolean'
  )
}

function isWaiting(value: unknown): value is WaitingRecord {
  return (
    isRecord(value) &&
    isString(value.stepId) &&
    isTime(value.since) &&
    isStringList(value.arrivals) &&
    (value.sentBack === null || isSentBack(value.sentBack)) &&
    isNullableString(value.retryNote) &&
    (value.blocked === null || isBlocked(value.blocked)) &&
    isNullableString(value.picker)
  )
}

function isHeld(value: unknown): boolean {
  return (
    isRecord(value) &&
    isStepPick(value.by) &&
    isPickedBy(value.pickedBy) &&
    isNullableString(value.reason) &&
    isNullableString(value.roundId)
  )
}

// The workflow was checked when the task started; this guards only what the engine reads of it.
function isLockedWorkflow(value: unknown): value is Workflow {
  return (
    isRecord(value) &&
    isString(value.name) &&
    Number.isSafeInteger(value.sendBackLimit) &&
    Array.isArray(value.steps) &&
    value.steps.length > 0 &&
    value.steps.every(
      (step) =>
        isRecord(step) &&
        isString(step.id) &&
        isString(step.name) &&
        isString(step.prompt) &&
        (step.by === 'agent' || step.by === 'you') &&
        isString(step.handIn) &&
        typeof step.youReview === 'boolean' &&
        isStringList(step.reviewOf) &&
        isRecord(step.tools) &&
        isStringList(step.tools.mcp) &&
        isStringList(step.tools.skills) &&
        (step.role === undefined || isString(step.role)) &&
        Array.isArray(step.outcomes) &&
        step.outcomes.every(
          (outcome) =>
            isRecord(outcome) &&
            isString(outcome.name) &&
            isStringList(outcome.to) &&
            (outcome.end === null || outcome.end === 'done' || outcome.end === 'dropped'),
        ),
    )
  )
}

/** A stored task, or null when it does not read. */
export function taskRecordOf(value: unknown): TaskRecord | null {
  if (!isRecord(value)) return null
  const first = value.first
  const ending = value.ending
  const ok =
    isString(value.id) &&
    TASK_ID.test(value.id) &&
    isString(value.projectPath) &&
    isString(value.title) &&
    isString(value.text) &&
    isString(value.workflowId) &&
    isString(value.workflowName) &&
    SOURCES.has(value.workflowSource) &&
    isString(value.workflowHash) &&
    isLockedWorkflow(value.workflow) &&
    isPace(value.pace) &&
    isNullableString(value.paceReason) &&
    isRecord(first) &&
    isAgentId(first.agentId) &&
    isRecord(first.options) &&
    isRecord(value.pins) &&
    Object.values(value.pins).every(isStepPick) &&
    STATUSES.has(value.status) &&
    (value.end === null || value.end === 'done' || value.end === 'dropped') &&
    Array.isArray(value.rounds) &&
    value.rounds.every(isRound) &&
    Array.isArray(value.waiting) &&
    value.waiting.every(isWaiting) &&
    Array.isArray(value.lanes) &&
    value.lanes.length > 0 &&
    value.lanes.every(isLane) &&
    isCountMap(value.arrows) &&
    isCountMap(value.extra) &&
    isRecord(value.ahead) &&
    Object.values(value.ahead).every(isHeld) &&
    Array.isArray(value.notes) &&
    value.notes.every((note) => isRecord(note) && isTime(note.at) && isString(note.text)) &&
    (ending === null ||
      (isRecord(ending) &&
        isString(ending.roundId) &&
        (ending.end === 'done' || ending.end === 'dropped') &&
        isString(ending.lane) &&
        isStringList(ending.conflicts) &&
        isNullableString(ending.error))) &&
    typeof value.needing === 'boolean' &&
    (value.from === null || (isRecord(value.from) && isString(value.from.sessionId))) &&
    isNullableTime(value.pinnedAt) &&
    isNullableTime(value.archivedAt) &&
    typeof value.unread === 'boolean' &&
    isTime(value.createdAt) &&
    isTime(value.updatedAt) &&
    isNullableTime(value.endedAt)
  return ok ? (structuredClone(value) as unknown as TaskRecord) : null
}

/** What the thread worker does with tasks, which share its database. */
export interface TaskCalls {
  /** Adds the task or replaces it whole. */
  put: { params: { task: TaskRecord }; result: null }
  /** Every task that reads; one that does not is left out and logged. */
  all: { params: void; result: TaskRecord[] }
  remove: { params: { taskId: string }; result: null }
}

export type TaskCallName = keyof TaskCalls

export type TaskCall = {
  [K in TaskCallName]: { name: K; params: TaskCalls[K]['params'] }
}[TaskCallName]
