// Tasks: a requirement run through an SOP, a flowchart of nodes. Each node is done by its own
// agent in its own session, or by the person. An agent cannot move the flow: it reports an
// outcome and hands in what the node asks for, and the host's engine follows that outcome's arrow.

import type { RoutineOption } from './routines'
import type { AgentId } from './thread'

/** A kind of agent. An SOP names tiers only; the user's tier settings say which agent each is. */
export type TaskTier = 'deep' | 'standard' | 'fast'
export const TASK_TIERS: readonly TaskTier[] = ['deep', 'standard', 'fast']

/** Where an SOP comes from: shipped with Kettu, or the user's own library. */
export type SopSource = 'official' | 'library'

export const SOP_FORMAT = 1

/**
 * What a node must hand in with its report, which the host checks is there and never judges:
 * a document (Markdown), a verdict (its outcome, of two or more, with the reason) or a note.
 */
export type HandIn = 'document' | 'verdict' | 'note'

/** One result a node may report, and the arrow it follows. */
export interface SopOutcome {
  id: string
  name: string
  /** The nodes it starts, all at once when several; empty when it ends the task. */
  to: string[]
  /** Set exactly when `to` is empty: the task is done, or dropped as not to be done. */
  end?: 'done' | 'dropped'
  /** Times this arrow may lead back to a node that already ran; the SOP's `rounds` when absent. */
  rounds?: number
}

export interface SopNode {
  id: string
  name: string
  /** What the agent is told to do, or what the person is asked. */
  prompt: string
  by: { kind: 'agent'; tier: TaskTier } | { kind: 'person' }
  /** A person's node hands in a verdict. */
  handIn: HandIn
  /** One at least; a verdict needs two or more. */
  outcomes: SopOutcome[]
}

/** An SOP after parsing and validation. */
export interface Sop {
  format: typeof SOP_FORMAT
  id: string
  name: string
  description: string
  start: string
  nodes: SopNode[]
  /** Times one arrow back may be taken before the person decides. */
  rounds: number
}

/** A node without its prompt; a person's node keeps what the person is asked. */
export type SopOutlineNode = Omit<SopNode, 'prompt'> & { question?: string }

/** An SOP's nodes and arrows without the agents' prompts, enough to draw it. */
export interface SopOutline {
  start: string
  nodes: SopOutlineNode[]
}

/** The SOP a task runs, locked when the task is created. */
export interface SopRef {
  source: SopSource
  id: string
  name: string
  /** SHA-256 of the SOP file as read, so a later edit is told apart. */
  hash: string
}

/** An SOP as the picker and the library list it. */
export interface SopSummary {
  source: SopSource
  id: string
  name: string
  description: string
  hash: string
  /** Null when it did not read. */
  outline: SopOutline | null
  /** Why it did not read, in words for the person; null when it did. */
  problem: string | null
  /**
   * `pending`: a library file the person has not approved as it is now, made by an agent or
   * changed since; no task can start with it.
   */
  status: 'ready' | 'pending'
  /** Who put it in the library, when Kettu knows. */
  madeBy: 'agent' | 'user' | null
}

export type TaskState =
  | 'running' // a node is working or queued
  | 'waiting' // nothing works: every open node waits for the person
  | 'done'
  | 'dropped' // ended by an outcome that says it is not to be done
  | 'cancelled'

/** A task as clients see it. */
export interface TaskView {
  id: string // 't-' and 12 hex digits
  title: string
  requirement: string
  projectPath: string
  sop: SopRef
  outline: SopOutline
  state: TaskState
  /** Some node waits for the person, whatever else is still working. */
  needsYou: boolean
  /** Nodes a branch has reached that wait for the other branches before they start. */
  arrived: string[]
  /** The task's own worktree, which the work of every branch ends up in; null in the project. */
  worktree: { path: string; branch: string; base: string } | null
  createdBy: 'user' | 'agent'
  createdAt: number
  updatedAt: number
  endedAt: number | null
  lastViewedAt: number | null
}

export type NodeRunState =
  | 'queued' // waits for a free slot
  | 'running'
  | 'waiting' // needs the person; `waiting` says why
  | 'done' // reported; `outcome` says what
  | 'stopped' // ended without a report: cancelled, or its work was sent back past it

/**
 * Why a run needs the person: the node is theirs; its session asks something (a permission or a
 * question); or it is stuck (the way back was taken too often, the agent stopped without
 * reporting, its agent could not start, or branches could not be merged).
 */
export type NodeWaiting = 'person' | 'request' | 'stuck'

/** One round of one node. */
export interface NodeRunView {
  id: string // 'nr-' and 12 hex digits
  taskId: string
  nodeId: string
  round: number // 1 for the first
  by: 'agent' | 'person'
  state: NodeRunState
  waiting: NodeWaiting | null
  /** Why it is stuck, in words for the person; null otherwise. */
  reason: string | null
  sessionId: string | null
  agentId: AgentId | null
  model: string | null
  tier: TaskTier | null
  /** The outcome reported, by its id in the node. */
  outcome: string | null
  /** The note or the reason handed in, or the person's note. */
  note: string | null
  /** A document was handed in; `tasks.document` reads it. */
  hasDocument: boolean
  /** Why this round began, when it was sent back: the node that sent it and its reason. */
  sentBack: { from: string; note: string } | null
  /** Where it works: the task's worktree or a branch's own; null in the project. */
  worktree: { path: string; branch: string } | null
  startedAt: number
  endedAt: number | null
}

/** The agent a tier stands for. */
export interface TierChoice {
  agentId: AgentId
  options: RoutineOption[] // model, model_config and thought_level, as sessions.create takes them
}

/** Null: the host picks from the installed agents. */
export type TierSettings = Record<TaskTier, TierChoice | null>

export interface TaskDraft {
  requirement: string
  title?: string // else the requirement's first line, cut to 80 characters
  projectPath: string
  sop: { source: SopSource; id: string }
}

/** The person's answer at their own node. */
export interface TaskDecision {
  taskId: string
  runId: string
  /** One of the node's outcomes. */
  outcome: string
  note?: string
}

/** The person lets a stuck run go on: another try, with what they want it told. */
export interface TaskRetry {
  taskId: string
  runId: string
  note?: string
}

export const REQUIREMENT_CHARS = 100_000
export const TITLE_CHARS = 200
export const NOTE_CHARS = 20_000
export const DOCUMENT_CHARS = 200_000
export const SOP_FILE_CHARS = 200_000
export const MAX_SOP_NODES = 40
export const MAX_NODE_OUTCOMES = 8
export const DEFAULT_ROUNDS = 3
export const MAX_TASK_SESSIONS = 3 // node sessions working at once, across tasks

/** The tier settings with the agent each tier stands for now, the host's pick where none is set. */
export interface TierState {
  settings: TierSettings
  agents: Record<TaskTier, { agentId: AgentId; model: string | null } | null>
}
