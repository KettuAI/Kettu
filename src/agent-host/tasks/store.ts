// The tasks file: tasks with their tokens, their node runs and the user's tiers, in
// <userData>/state/tasks.json. A record that does not read is dropped alone, so one bad task
// never loses the others.

import path from 'node:path'
import { isAgentId } from '@shared/agents'
import {
  SOP_FORMAT,
  TASK_TIERS,
  type NodeRunState,
  type NodeWaiting,
  type Sop,
  type SopNode,
  type SopOutcome,
  type TaskState,
} from '@shared/tasks'
import { JsonFile, type LogFn, type Migration, type WorktreeRecord } from '../storage'
import type { NodeRunRecord, TaskRecord, TasksFile, TokenRecord } from './api'
import { emptyTiers, parseTierSettings } from './tiers'

export const TASKS_VERSION = 2
// Version 1 held tasks of a model that was never released; nothing of it carries over.
export const TASKS_MIGRATIONS: Readonly<Record<number, Migration>> = {
  1: () => ({ tasks: [], runs: [], tiers: emptyTiers() }),
}

/** What the engine needs of the file, so tests can hand it one in memory. */
export type TasksStore = Pick<JsonFile<TasksFile>, 'load' | 'save' | 'flush'>

export const TASK_ID = /^t-[0-9a-f]{12}$/
export const RUN_ID = /^nr-[0-9a-f]{12}$/
const TOKEN_ID = /^tk-[0-9a-f]{12}$/

const TASK_STATES: ReadonlySet<unknown> = new Set<TaskState>([
  'running',
  'waiting',
  'done',
  'dropped',
  'cancelled',
])
const RUN_STATES: ReadonlySet<unknown> = new Set<NodeRunState>([
  'queued',
  'running',
  'waiting',
  'done',
  'stopped',
])
const WAITING: ReadonlySet<unknown> = new Set<NodeWaiting>(['person', 'request', 'stuck'])
const SOURCES: ReadonlySet<unknown> = new Set(['official', 'library'])
const HAND_INS: ReadonlySet<unknown> = new Set(['document', 'verdict', 'note'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
const isString = (value: unknown): value is string => typeof value === 'string'
const isTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
const isCount = (value: unknown): value is number => isTime(value) && Number.isInteger(value)
const isNullableTime = (value: unknown): value is number | null => value === null || isTime(value)
const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string'
const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isString)

function isOutcome(value: unknown): value is SopOutcome {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.name) &&
    isStringList(value.to) &&
    (value.to.length > 0
      ? value.end === undefined
      : value.end === 'done' || value.end === 'dropped') &&
    (value.rounds === undefined || isCount(value.rounds))
  )
}

function isNode(value: unknown): value is SopNode {
  if (!isRecord(value) || !isString(value.id) || !isString(value.name)) return false
  const by = value.by
  return (
    isString(value.prompt) &&
    isRecord(by) &&
    (by.kind === 'person' || (by.kind === 'agent' && TASK_TIERS.includes(by.tier as never))) &&
    HAND_INS.has(value.handIn) &&
    Array.isArray(value.outcomes) &&
    value.outcomes.length > 0 &&
    value.outcomes.every(isOutcome)
  )
}

// The snapshot was validated when the task was made; this only guards what the engine reads.
export function isSopSnapshot(value: unknown): value is Sop {
  if (!isRecord(value) || value.format !== SOP_FORMAT) return false
  if (!isString(value.id) || !isString(value.name) || !isString(value.description)) return false
  if (!isString(value.start) || !isCount(value.rounds)) return false
  if (!Array.isArray(value.nodes) || value.nodes.length === 0 || !value.nodes.every(isNode)) {
    return false
  }
  const ids = new Set(value.nodes.map((node) => (node as SopNode).id))
  return (
    ids.size === value.nodes.length &&
    ids.has(value.start) &&
    value.nodes.every((node) =>
      (node as SopNode).outcomes.every((outcome) => outcome.to.every((to) => ids.has(to))),
    )
  )
}

function worktreeOf(value: unknown): WorktreeRecord | undefined {
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

function nullableWorktreeOf(value: unknown): WorktreeRecord | null | undefined {
  return value === null ? null : worktreeOf(value)
}

function worktreesOf(value: unknown): WorktreeRecord[] | null {
  if (!Array.isArray(value)) return null
  const list: WorktreeRecord[] = []
  for (const item of value) {
    const worktree = worktreeOf(item)
    if (!worktree) return null
    list.push(worktree)
  }
  return list
}

function tokenOf(value: unknown, snapshot: Sop): TokenRecord | null {
  if (!isRecord(value) || !isString(value.id) || !TOKEN_ID.test(value.id)) return null
  const lanes = worktreesOf(value.lanes)
  const from = value.from
  if (
    !isString(value.nodeId) ||
    !snapshot.nodes.some((node) => node.id === value.nodeId) ||
    !isNullableString(value.runId) ||
    lanes === null ||
    !(
      from === null ||
      (isRecord(from) &&
        isString(from.nodeId) &&
        isString(from.outcome) &&
        isString(from.note) &&
        typeof from.back === 'boolean')
    )
  ) {
    return null
  }
  return {
    id: value.id,
    nodeId: value.nodeId,
    runId: value.runId,
    lanes,
    from: from && {
      nodeId: from.nodeId as string,
      outcome: from.outcome as string,
      note: from.note as string,
      back: from.back as boolean,
    },
  }
}

function roundsOf(value: unknown): Record<string, number> | null {
  if (!isRecord(value)) return null
  const rounds: Record<string, number> = {}
  for (const [key, count] of Object.entries(value)) {
    if (!isCount(count)) return null
    rounds[key] = count
  }
  return rounds
}

function spentOf(value: unknown): TaskRecord['spent'] | null {
  if (!Array.isArray(value)) return null
  const spent: TaskRecord['spent'] = []
  for (const item of value) {
    const worktree = isRecord(item) ? worktreeOf(item.worktree) : undefined
    if (!worktree || typeof (item as Record<string, unknown>).merged !== 'boolean') return null
    spent.push({ worktree, merged: (item as { merged: boolean }).merged })
  }
  return spent
}

/** Reads a task, or null when a field is missing or out of range. */
export function taskOf(value: unknown): TaskRecord | null {
  if (!isRecord(value)) return null
  const sop = value.sop
  const worktree = nullableWorktreeOf(value.worktree)
  const rounds = roundsOf(value.rounds)
  const spent = spentOf(value.spent)
  if (
    !isString(value.id) ||
    !TASK_ID.test(value.id) ||
    !isString(value.title) ||
    !isString(value.requirement) ||
    !isString(value.projectPath) ||
    !isRecord(sop) ||
    !SOURCES.has(sop.source) ||
    !isString(sop.id) ||
    !isString(sop.name) ||
    !isString(sop.hash) ||
    !isSopSnapshot(value.snapshot) ||
    !TASK_STATES.has(value.state) ||
    worktree === undefined ||
    !Array.isArray(value.tokens) ||
    rounds === null ||
    spent === null ||
    !(value.createdBy === 'user' || value.createdBy === 'agent') ||
    !isTime(value.createdAt) ||
    !isTime(value.updatedAt) ||
    !isNullableTime(value.endedAt) ||
    !isNullableTime(value.lastViewedAt)
  ) {
    return null
  }
  const tokens: TokenRecord[] = []
  for (const item of value.tokens) {
    const token = tokenOf(item, value.snapshot)
    if (!token) return null
    tokens.push(token)
  }
  return {
    id: value.id,
    title: value.title,
    requirement: value.requirement,
    projectPath: value.projectPath,
    sop: {
      source: sop.source as TaskRecord['sop']['source'],
      id: sop.id,
      name: sop.name,
      hash: sop.hash,
    },
    snapshot: value.snapshot,
    state: value.state as TaskState,
    worktree,
    tokens,
    rounds,
    spent,
    createdBy: value.createdBy,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    endedAt: value.endedAt,
    lastViewedAt: value.lastViewedAt,
  }
}

/** Reads a node run, or null when a field is missing or out of range. */
export function runOf(value: unknown): NodeRunRecord | null {
  if (!isRecord(value)) return null
  const worktree = nullableWorktreeOf(value.worktree)
  const toMerge = worktreesOf(value.toMerge)
  const sentBack = value.sentBack
  if (
    !isString(value.id) ||
    !RUN_ID.test(value.id) ||
    !isString(value.taskId) ||
    !isString(value.nodeId) ||
    !isCount(value.round) ||
    value.round < 1 ||
    !(value.by === 'agent' || value.by === 'person') ||
    !RUN_STATES.has(value.state) ||
    !(value.waiting === null || WAITING.has(value.waiting)) ||
    (value.state === 'waiting') !== (value.waiting !== null) ||
    !isNullableString(value.reason) ||
    !isNullableString(value.sessionId) ||
    !(value.agentId === null || isAgentId(value.agentId)) ||
    !isNullableString(value.model) ||
    !(value.tier === null || TASK_TIERS.includes(value.tier as never)) ||
    !isNullableString(value.outcome) ||
    !isNullableString(value.note) ||
    !isNullableString(value.document) ||
    !(
      sentBack === null ||
      (isRecord(sentBack) && isString(sentBack.from) && isString(sentBack.note))
    ) ||
    worktree === undefined ||
    toMerge === null ||
    !isTime(value.startedAt) ||
    !isNullableTime(value.endedAt) ||
    typeof value.reminded !== 'boolean'
  ) {
    return null
  }
  return {
    id: value.id,
    taskId: value.taskId,
    nodeId: value.nodeId,
    round: value.round,
    by: value.by,
    state: value.state as NodeRunState,
    waiting: value.waiting as NodeWaiting | null,
    reason: value.reason,
    sessionId: value.sessionId,
    agentId: value.agentId as NodeRunRecord['agentId'],
    model: value.model,
    tier: value.tier as NodeRunRecord['tier'],
    outcome: value.outcome,
    note: value.note,
    sentBack: sentBack && { from: sentBack.from as string, note: sentBack.note as string },
    startedAt: value.startedAt,
    endedAt: value.endedAt,
    document: value.document,
    worktree,
    reminded: value.reminded,
    toMerge,
  }
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
  const runs: NodeRunRecord[] = []
  const runIds = new Set<string>()
  for (const [index, item] of data.runs.entries()) {
    const run = runOf(item)
    if (!run || runIds.has(run.id) || !ids.has(run.taskId)) {
      log?.('warn', `tasks.json: node run ${index} is malformed or orphaned and was dropped`)
      continue
    }
    runIds.add(run.id)
    runs.push(run)
  }
  let tiers = emptyTiers()
  if (data.tiers !== null && data.tiers !== undefined) {
    const parsed = parseTierSettings(data.tiers)
    if (typeof parsed === 'string') log?.('warn', `tasks.json: tiers dropped (${parsed})`)
    else tiers = parsed
  }
  return { version: TASKS_VERSION, tasks, runs, tiers }
}

export function emptyTasksFile(): TasksFile {
  return { version: TASKS_VERSION, tasks: [], runs: [], tiers: emptyTiers() }
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
