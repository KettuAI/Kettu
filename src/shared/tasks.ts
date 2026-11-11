// Tasks: a requirement run through a workflow of stages, each stage a prompt for an agent plus
// checks the host enforces. The host's engine alone moves a task between stages; an agent only
// submits its stage's result.

import type { RoutineOption, PermissionScope } from './routines'
import type { AgentId } from './thread'

/** A capability tier. A workflow names tiers only; the user's tier settings pick the agent. */
export type TaskTier = 'deep' | 'standard' | 'fast'
export const TASK_TIERS: readonly TaskTier[] = ['deep', 'standard', 'fast']

/** A requirement's size, as its review stage judges it. Conditions and tiers can follow it. */
export type TaskSize = 'S' | 'M' | 'L'

/** Where a workflow comes from. A project's own is read from its default branch only. */
export type WorkflowSource = 'official' | 'project' | 'library'

/** The workflow a task runs, locked when the task is created. */
export interface WorkflowRef {
  source: WorkflowSource
  id: string
  version: string
  /** SHA-256 of the workflow file as read, so an edit after creation is told apart. */
  hash: string
}

export const WORKFLOW_FORMAT = 1

/** A stage runs only when its condition holds; otherwise it is skipped. Its keys combine with OR. */
export interface StageCondition {
  size?: TaskSize[]
  risk?: boolean
}

/** A field the submitted result must carry. `size` and `risk` also set the task's own. */
export interface ContractField {
  name: string
  type: 'text' | 'list' | 'size' | 'risk'
  required: boolean
  description: string
}

/**
 * What the host checks in the session's tool calls during the stage, never taken from the
 * agent's word: a command actually ran; every command the agent reports in `commands` ran;
 * files changed; or no file changed.
 */
export type Evidence = 'ran-command' | 'reported-commands-ran' | 'changed-files' | 'no-file-changes'

/** Where a stage goes when its result is not a pass, and how many times before a person decides. */
export interface ReworkEdge {
  to: string
  rounds: number
}

interface StageBase {
  id: string
  name: string
  /** The stage after a pass; null ends the task. */
  next: string | null
  when?: StageCondition
}

/** The agent works in a session and submits its result through the submit tool. */
export interface AgentStage extends StageBase {
  kind: 'agent'
  prompt: string
  tier: TaskTier | { S?: TaskTier; M?: TaskTier; L?: TaskTier; default: TaskTier }
  requires?: {
    /** Pick an agent of another harness than the one that ran this stage last. */
    otherHarnessThan?: string
  }
  scope: PermissionScope
  /** `resume`: a later round goes back to this stage's session; `new` opens another. */
  session: 'resume' | 'new'
  contract: ContractField[]
  evidence: Evidence[]
  /** `contract`: a pass whose contract and evidence hold moves on; `agent`: the verdict decides. */
  gate: 'contract' | 'agent'
  /** Where a `changes` verdict sends the task. Absent: `changes` is refused for this stage. */
  rework?: ReworkEdge
}

/** The person approves or sends back, in Needs you; nothing runs meanwhile. */
export interface HumanStage extends StageBase {
  kind: 'human'
  /** What the person is asked, shown with the stage. */
  prompt: string
  /** The stages a person may send the task back to. */
  sendBack: string[]
}

/** Kettu itself acts: pushes the task's branch and opens a pull request. */
export interface HandoverStage extends StageBase {
  kind: 'handover'
  action: 'pull-request'
}

export type WorkflowStage = AgentStage | HumanStage | HandoverStage

/** A workflow after parsing and validation. */
export interface Workflow {
  format: typeof WORKFLOW_FORMAT
  id: string
  name: string
  description: string
  /** The kind of requirement it suits, named by the workflow: 'development', 'research'... */
  kind: string
  version: string
  /** Whether a task gets its own worktree. */
  worktree: boolean
  start: string
  stages: WorkflowStage[]
  limits: {
    /** The default round limit of every rework edge that names none. */
    rounds: number
    /** Working minutes one stage may take before it is stopped and the task blocked. */
    stageMinutes: number
    /** Estimated cost after which the task is blocked; null for none. */
    budgetUsd: number | null
  }
}

/** A workflow as the picker lists it. `problem`: it did not read, with why. */
export interface WorkflowSummary {
  source: WorkflowSource
  id: string
  name: string
  description: string
  kind: string
  version: string
  stages: { id: string; name: string; kind: WorkflowStage['kind'] }[]
  problem: string | null
}

export type TaskState =
  | 'backlog' // in the pool, waiting for the person to start it
  | 'queued' // started, waiting for a slot
  | 'running' // a stage is working
  | 'waiting' // waiting on the person: a human stage, a permission request or a question
  | 'blocked' // a limit was reached or the stage failed; the person decides
  | 'paused' // by the person, an offline host or a plan limit; resumes by itself unless by the person
  | 'done'
  | 'cancelled'

export type TaskPriority = 'low' | 'normal' | 'high'

/** A task as clients see it. */
export interface TaskView {
  id: string // 't-' and 12 hex digits
  title: string
  requirement: string
  projectPath: string
  workflow: WorkflowRef & { name: string }
  /** `sendBack`: a human stage's allowed targets. */
  stages: { id: string; name: string; kind: WorkflowStage['kind']; sendBack?: string[] }[]
  state: TaskState
  /** Why it is waiting, blocked or paused, in words for the person; null otherwise. */
  reason: string | null
  stageId: string | null
  priority: TaskPriority
  after: string[] // tasks that must be done first
  size: TaskSize | null
  risk: boolean
  worktree: { path: string; branch: string; base: string } | null
  pullRequest: string | null
  costUsd: number
  createdBy: 'user' | 'agent'
  createdAt: number
  updatedAt: number
  startedAt: number | null
  endedAt: number | null
  lastViewedAt: number | null
}

export type StageRunState =
  | 'running'
  | 'waiting' // an agent stage waiting on a permission request, or a human stage
  | 'passed'
  | 'changes' // sent back
  | 'blocked'
  | 'skipped'
  | 'interrupted'

/** One round of one stage. */
export interface StageRunView {
  id: string // 'sr-' and 12 hex digits
  taskId: string
  stageId: string
  round: number // 1 for the first
  kind: WorkflowStage['kind']
  state: StageRunState
  sessionId: string | null
  agentId: AgentId | null
  model: string | null
  tier: TaskTier | null
  summary: string | null
  fields: Record<string, string | string[] | boolean>
  /** What the host found in the session's tool calls during this round. */
  evidence: { commands: string[]; changedFiles: string[] } | null
  /** Why it was refused, sent back or blocked. */
  note: string | null
  costUsd: number
  startedAt: number
  endedAt: number | null
}

/** One agent a tier may use, in the order tried. */
export interface TierCandidate {
  agentId: AgentId
  options: RoutineOption[] // model, model_config and thought_level, as sessions.create takes them
}

export type TierSettings = Record<TaskTier, TierCandidate[]>

export interface TaskDraft {
  requirement: string
  title?: string // else the requirement's first line, cut to 80 characters
  projectPath: string
  workflow: { source: WorkflowSource; id: string }
  /** true: queue it now; false: keep it in the backlog. */
  start: boolean
  priority?: TaskPriority
  after?: string[]
}

/** The person's answer to a human stage, or to a blocked task. */
export interface TaskDecision {
  taskId: string
  decision: 'approve' | 'send-back'
  /** For send-back: one of the stage's `sendBack` stages, or any agent stage when blocked. */
  to?: string
  note?: string
}

export const REQUIREMENT_CHARS = 100_000
export const TITLE_CHARS = 200
export const NOTE_CHARS = 20_000
export const MAX_TASK_SESSIONS = 3 // stage sessions working at once, by default
