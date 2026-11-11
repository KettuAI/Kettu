// The tasks file: tasks, their stage runs and the user's tiers, in <userData>/state/tasks.json.
// A record that does not read is dropped alone, so one bad task never loses the others.

import path from 'node:path'
import { isAgentId } from '@shared/agents'
import { isPermissionScope } from '@shared/routines'
import {
  TASK_TIERS,
  type StageRunState,
  type TaskPriority,
  type TaskState,
  type Workflow,
  type WorkflowStage,
} from '@shared/tasks'
import { JsonFile, type LogFn, type Migration, type WorktreeRecord } from '../storage'
import type { StageRunRecord, TaskRecord, TasksFile } from './api'
import { parseTierSettings } from './tiers'

export const TASKS_VERSION = 1
// No older formats exist yet; each future version adds its step here, with a test.
export const TASKS_MIGRATIONS: Readonly<Record<number, Migration>> = {}

/** What the engine needs of the file, so tests can hand it one in memory. */
export type TasksStore = Pick<JsonFile<TasksFile>, 'load' | 'save' | 'flush'>

export const TASK_ID = /^t-[0-9a-f]{12}$/
export const RUN_ID = /^sr-[0-9a-f]{12}$/

const TASK_STATES: ReadonlySet<unknown> = new Set<TaskState>([
  'backlog',
  'queued',
  'running',
  'waiting',
  'blocked',
  'paused',
  'done',
  'cancelled',
])
const RUN_STATES: ReadonlySet<unknown> = new Set<StageRunState>([
  'running',
  'waiting',
  'passed',
  'changes',
  'blocked',
  'skipped',
  'interrupted',
])
const PRIORITIES: ReadonlySet<unknown> = new Set<TaskPriority>(['low', 'normal', 'high'])
const SOURCES: ReadonlySet<unknown> = new Set(['official', 'project', 'library'])
const STAGE_KINDS: ReadonlySet<unknown> = new Set(['agent', 'human', 'handover'])
const SIZES: ReadonlySet<unknown> = new Set(['S', 'M', 'L'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
const isString = (value: unknown): value is string => typeof value === 'string'
const isTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
const isNullableTime = (value: unknown): value is number | null => value === null || isTime(value)
const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string'
const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isString)

// The snapshot was validated when the task was made; this only guards what the engine reads.
function isStage(value: unknown): value is WorkflowStage {
  if (!isRecord(value) || !isString(value.id) || !isString(value.name)) return false
  if (!STAGE_KINDS.has(value.kind) || !isNullableString(value.next)) return false
  if (value.kind === 'agent') {
    return (
      isString(value.prompt) &&
      (TASK_TIERS.includes(value.tier as never) || isRecord(value.tier)) &&
      isPermissionScope(value.scope) &&
      (value.session === 'resume' || value.session === 'new') &&
      Array.isArray(value.contract) &&
      value.contract.every((field) => isRecord(field) && isString(field.name)) &&
      isStringList(value.evidence) &&
      (value.gate === 'contract' || value.gate === 'agent')
    )
  }
  if (value.kind === 'human') return isString(value.prompt) && isStringList(value.sendBack)
  return value.action === 'pull-request'
}

export function isWorkflowSnapshot(value: unknown): value is Workflow {
  if (!isRecord(value) || !isString(value.id) || !isString(value.name)) return false
  if (!isString(value.start) || typeof value.worktree !== 'boolean') return false
  if (!Array.isArray(value.stages) || value.stages.length === 0 || !value.stages.every(isStage)) {
    return false
  }
  const limits = value.limits
  return (
    isRecord(limits) &&
    isTime(limits.rounds) &&
    isTime(limits.stageMinutes) &&
    (limits.budgetUsd === null || isTime(limits.budgetUsd)) &&
    value.stages.some((stage) => (stage as WorkflowStage).id === value.start)
  )
}

function worktreeOf(value: unknown): WorktreeRecord | null | undefined {
  if (value === null) return null
  if (
    !isRecord(value) ||
    !isString(value.path) ||
    !isString(value.branch) ||
    !isString(value.base) ||
    !isString(value.baseOid)
  ) {
    return undefined
  }
  const record: WorktreeRecord = {
    path: value.path,
    branch: value.branch,
    base: value.base,
    baseOid: value.baseOid,
  }
  if (value.removed === 'worktree' || value.removed === 'branch') record.removed = value.removed
  if (value.pending === true) record.pending = true
  return record
}

function roundsOf(value: unknown): Record<string, number> | null {
  if (!isRecord(value)) return null
  const rounds: Record<string, number> = {}
  for (const [key, count] of Object.entries(value)) {
    if (!isTime(count) || !Number.isInteger(count)) return null
    rounds[key] = count
  }
  return rounds
}

/** Reads a task, or null when a field is missing or out of range. */
export function taskOf(value: unknown): TaskRecord | null {
  if (!isRecord(value)) return null
  const workflow = value.workflow
  const worktree = worktreeOf(value.worktree)
  const rounds = roundsOf(value.rounds)
  if (
    !isString(value.id) ||
    !TASK_ID.test(value.id) ||
    !isString(value.title) ||
    !isString(value.requirement) ||
    !isString(value.projectPath) ||
    !isRecord(workflow) ||
    !SOURCES.has(workflow.source) ||
    !isString(workflow.id) ||
    !isString(workflow.version) ||
    !isString(workflow.hash) ||
    !isString(workflow.name) ||
    !isWorkflowSnapshot(value.snapshot) ||
    !TASK_STATES.has(value.state) ||
    !isNullableString(value.reason) ||
    !isNullableString(value.stageId) ||
    !PRIORITIES.has(value.priority) ||
    !isStringList(value.after) ||
    !(value.size === null || SIZES.has(value.size)) ||
    typeof value.risk !== 'boolean' ||
    worktree === undefined ||
    !isNullableString(value.pullRequest) ||
    !isTime(value.costUsd) ||
    !(value.createdBy === 'user' || value.createdBy === 'agent') ||
    !isTime(value.createdAt) ||
    !isTime(value.updatedAt) ||
    !isNullableTime(value.startedAt) ||
    !isNullableTime(value.endedAt) ||
    !isNullableTime(value.lastViewedAt) ||
    rounds === null ||
    typeof value.pausedByUser !== 'boolean' ||
    !(value.notes === undefined || isNullableString(value.notes))
  ) {
    return null
  }
  return {
    id: value.id,
    title: value.title,
    requirement: value.requirement,
    projectPath: value.projectPath,
    workflow: {
      source: workflow.source as TaskRecord['workflow']['source'],
      id: workflow.id,
      version: workflow.version,
      hash: workflow.hash,
      name: workflow.name,
    },
    snapshot: value.snapshot,
    state: value.state as TaskState,
    reason: value.reason,
    stageId: value.stageId,
    priority: value.priority as TaskPriority,
    after: [...value.after],
    size: value.size as TaskRecord['size'],
    risk: value.risk,
    worktree,
    pullRequest: value.pullRequest,
    costUsd: value.costUsd,
    createdBy: value.createdBy,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    startedAt: value.startedAt,
    endedAt: value.endedAt,
    lastViewedAt: value.lastViewedAt,
    rounds,
    pausedByUser: value.pausedByUser,
    notes: (value.notes as string | null | undefined) ?? null,
  }
}

function fieldsOf(value: unknown): StageRunRecord['fields'] | null {
  if (!isRecord(value)) return null
  const fields: StageRunRecord['fields'] = {}
  for (const [key, field] of Object.entries(value)) {
    if (!(isString(field) || typeof field === 'boolean' || isStringList(field))) return null
    fields[key] = Array.isArray(field) ? [...field] : field
  }
  return fields
}

function evidenceOf(value: unknown): StageRunRecord['evidence'] | undefined {
  if (value === null) return null
  if (!isRecord(value) || !isStringList(value.commands) || !isStringList(value.changedFiles)) {
    return undefined
  }
  return { commands: [...value.commands], changedFiles: [...value.changedFiles] }
}

/** Reads a stage run, or null when a field is missing or out of range. */
export function runOf(value: unknown): StageRunRecord | null {
  if (!isRecord(value)) return null
  const fields = fieldsOf(value.fields)
  const evidence = evidenceOf(value.evidence)
  if (
    !isString(value.id) ||
    !RUN_ID.test(value.id) ||
    !isString(value.taskId) ||
    !isString(value.stageId) ||
    typeof value.round !== 'number' ||
    !Number.isInteger(value.round) ||
    value.round < 1 ||
    !STAGE_KINDS.has(value.kind) ||
    !RUN_STATES.has(value.state) ||
    !isNullableString(value.sessionId) ||
    !(value.agentId === null || isAgentId(value.agentId)) ||
    !isNullableString(value.model) ||
    !(value.tier === null || TASK_TIERS.includes(value.tier as never)) ||
    !isNullableString(value.summary) ||
    fields === null ||
    evidence === undefined ||
    !isNullableString(value.note) ||
    !isTime(value.costUsd) ||
    !isTime(value.startedAt) ||
    !isNullableTime(value.endedAt) ||
    !isTime(value.fromTurn) ||
    typeof value.nudged !== 'boolean' ||
    !isTime(value.workedMs) ||
    !(value.escalate === undefined || typeof value.escalate === 'boolean')
  ) {
    return null
  }
  const run: StageRunRecord = {
    id: value.id,
    taskId: value.taskId,
    stageId: value.stageId,
    round: value.round,
    kind: value.kind as StageRunRecord['kind'],
    state: value.state as StageRunState,
    sessionId: value.sessionId,
    agentId: value.agentId as StageRunRecord['agentId'],
    model: value.model,
    tier: value.tier as StageRunRecord['tier'],
    summary: value.summary,
    fields,
    evidence,
    note: value.note,
    costUsd: value.costUsd,
    startedAt: value.startedAt,
    endedAt: value.endedAt,
    fromTurn: value.fromTurn,
    nudged: value.nudged,
    workedMs: value.workedMs,
  }
  if (value.escalate === true) run.escalate = true
  return run
}

/**
 * Parses the file. A task or run that does not read is dropped and logged, never failing the
 * file; runs of a task that is gone go with it.
 */
export function parseTasksFile(data: Record<string, unknown>, log?: LogFn): TasksFile | string {
  if (!Array.isArray(data.tasks)) return 'tasks is not a list'
  if (!Array.isArray(data.runs)) return 'runs is not a list'
  const tasks: TaskRecord[] = []
  const ids = new Set<string>()
  for (const [index, item] of data.tasks.entries()) {
    const task = taskOf(item)
    if (!task || ids.has(task.id)) {
      log?.('warn', `tasks.json: task ${index} is malformed and was dropped`)
      continue
    }
    ids.add(task.id)
    tasks.push(task)
  }
  const runs: StageRunRecord[] = []
  const runIds = new Set<string>()
  for (const [index, item] of data.runs.entries()) {
    const run = runOf(item)
    if (!run || runIds.has(run.id) || !ids.has(run.taskId)) {
      log?.('warn', `tasks.json: stage run ${index} is malformed or orphaned and was dropped`)
      continue
    }
    runIds.add(run.id)
    runs.push(run)
  }
  let tiers: TasksFile['tiers'] = null
  if (data.tiers !== null && data.tiers !== undefined) {
    const parsed = parseTierSettings(data.tiers)
    if (typeof parsed === 'string') log?.('warn', `tasks.json: tiers dropped (${parsed})`)
    else tiers = parsed
  }
  return { version: 1, tasks, runs, tiers }
}

export function emptyTasksFile(): TasksFile {
  return { version: 1, tasks: [], runs: [], tiers: null }
}

export function tasksFile(userDataPath: string, log: LogFn): JsonFile<TasksFile> {
  return new JsonFile<TasksFile>({
    file: path.join(userDataPath, 'state', 'tasks.json'),
    version: TASKS_VERSION,
    migrations: TASKS_MIGRATIONS,
    parse: (data) => parseTasksFile(data, log),
    empty: emptyTasksFile,
    log,
  })
}
