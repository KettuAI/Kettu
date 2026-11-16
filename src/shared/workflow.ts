// Workflows and the tasks that run through them: a workflow is a flowchart of steps, a task runs one
// requirement through it, each agent step in a session of its own. Shared by the agent host and
// its clients.

import { isAgentId } from './agents'
import type { AgentId } from './thread'

export const WORKFLOW_FORMAT = 1
export const WORKFLOW_FILE_BYTES = 256 * 1024
export const MAX_WORKFLOW_STEPS = 30
export const MAX_OUTCOMES = 8
export const MAX_TOOLS = 20
export const DEFAULT_SEND_BACK_LIMIT = 3
export const MAX_SEND_BACK_LIMIT = 20
/** Step sessions working at once, across every task of the host. */
export const MAX_WORKING_STEPS = 3
export const WORKFLOW_NAME_CHARS = 80
export const WORKFLOW_DESCRIPTION_CHARS = 2_000
export const STEP_PROMPT_CHARS = 20_000
export const STEP_HINT_CHARS = 500
export const WORKFLOW_ID_CHARS = 64
export const TASK_TEXT_CHARS = 100_000
export const TASK_TITLE_CHARS = 120
export const TASK_NOTE_CHARS = 8_000
export const REPORT_NOTE_CHARS = 8_000
export const PICK_REASON_CHARS = 300
/** A task's notes, kept whole for the steps that come after them. */
export const MAX_TASK_NOTES = 50

export const PACES = ['quick', 'balanced', 'thorough'] as const
/** How fast or careful a task should be; handed to every agent that picks, nothing more. */
export type Pace = (typeof PACES)[number]

export type StepBy = 'agent' | 'you'
/** What a step must hand in: a document artifact, a conclusion among its outcomes, or a note. */
export type HandIn = 'document' | 'outcome' | 'note'
export type TaskEnd = 'done' | 'dropped'

/** One arrow of a step: where an outcome goes, to steps or to the task's end. */
export interface WorkflowOutcome {
  name: string
  /** The steps it starts, several at once for parallel work; empty when it ends the task. */
  to: string[]
  end: TaskEnd | null
  /** This arrow's own send-back limit, when it points back; the workflow's otherwise. */
  limit: number | null
}

/** The MCP servers and Skills a step's session is handed, by the names Kettu knows them by. */
export interface StepTools {
  mcp: string[]
  skills: string[]
}

export interface WorkflowStep {
  id: string
  name: string
  /** What to do; on a person's step, what to ask them. */
  prompt: string
  by: StepBy
  handIn: HandIn
  outcomes: WorkflowOutcome[]
  /** The person approves what it hands in before its arrow is followed. */
  youReview: boolean
  /** Free text for whoever picks the step's agent. */
  hint: string | null
  /** The steps it reviews, whose agent and model it must not share. */
  reviewOf: string[]
  tools: StepTools
}

/** A workflow's name, description and step names in another language. */
export interface WorkflowLocale {
  name?: string
  description?: string
  steps?: Record<string, string>
}

export interface Workflow {
  format: typeof WORKFLOW_FORMAT
  name: string
  description: string
  locales: Record<string, WorkflowLocale>
  sendBackLimit: number
  /** In forward order; the first is the start. An arrow to itself or an earlier step sends back. */
  steps: WorkflowStep[]
}

/** Where the validator found a problem: a path such as `steps[2].outcomes[0].to`, and why. */
export interface WorkflowProblem {
  at: string
  message: string
}

// The library.

/** How a workflow came into the user's library. */
export type WorkflowSource = 'github' | 'file' | 'agent' | 'user' | 'community'

export type WorkflowOrigin =
  | { kind: 'github'; url: string } // the file's page or raw URL as given
  | { kind: 'file'; name: string } // the file name the user picked
  | { kind: 'agent'; sessionId: string; agentId: AgentId }
  // A listing of the Kettu Marketplace and the version installed; `official` when Kettu's own
  // publisher published it.
  | {
      kind: 'community'
      listingId: string
      version: string
      handle: string
      slug: string
      official: boolean
    }

/**
 * Whether a workflow may start tasks: only while its content is the one the user approved.
 * `changed` was approved, then changed.
 */
export type WorkflowApproval = 'approved' | 'pending' | 'changed'

/** Who does a step: an agent with its model and effort; null ones leave the agent's own. */
export interface StepPick {
  agentId: AgentId
  model: string | null
  effort: string | null
}

export interface WorkflowEntry {
  id: string
  source: WorkflowSource
  /** Null when the file does not read; `problems` says why. */
  workflow: Workflow | null
  /** The workflow's name, or the file's when it does not read. */
  name: string
  /** Empty for one that can be used; the tools' names are checked against the host's. */
  problems: WorkflowProblem[]
  approval: WorkflowApproval
  /** SHA-256 of the file as read, hex; what an approval names. */
  hash: string
  origin: WorkflowOrigin | null
  /** The file on the host; null from an older host for a workflow it shipped with. */
  file: string | null
  addedAt: number | null
  /** Who does each step for every task of this workflow, by step id; Auto for the rest. */
  pins: Record<string, StepPick>
}

/** A workflow is usable for a new task: it reads, has no problem and is approved. */
export function usableWorkflow(entry: WorkflowEntry): boolean {
  return entry.workflow !== null && entry.problems.length === 0 && entry.approval === 'approved'
}

export interface WorkflowSettings {
  /** Agents of ordinary sessions see list_workflows and suggest_workflow. */
  suggest: boolean
  /** The Claude Code and Codex agents and whether Auto may pick them; disabled ones are left out. */
  agents: { agentId: AgentId; allowed: boolean; byDefault: boolean }[]
}

export interface WorkflowSettingsChange {
  suggest?: boolean
  /** By agent; null goes back to the default: subscriptions on, API keys off. */
  autoPick?: Partial<Record<AgentId, boolean | null>>
}

export type WorkflowAddSource =
  { kind: 'url'; url: string } | { kind: 'file'; name: string; text: string }

// Tasks.

export type TaskStatus = 'running' | 'done' | 'dropped' | 'cancelled'

/**
 * A step's state as the progress ring draws it: `done` green, `running` fox orange, `needs_you`
 * amber, `error` red, the rest gray.
 */
export type StepState = 'not_reached' | 'waiting' | 'running' | 'needs_you' | 'error' | 'done'

/** How a round's agent was chosen. */
export type PickedBy =
  | { kind: 'first' } // New session's tray or the suggestion card
  | { kind: 'task_pin' }
  | { kind: 'workflow_pin' }
  | { kind: 'agent'; stepId: string; roundId: string; agentId: AgentId } // the step that handed off
  | { kind: 'previous'; roundId: string } // a step sent back keeps its person
  | { kind: 'person' } // a person's step

/**
 * A round's state: `queued` waits for a free session, `starting` opens its session, `working` until
 * its report, `picking` until it picked who does the next steps, `reviewing` while the person
 * reviews what it handed in, `person` while a person's step waits for its answer, `stuck` while it
 * waits for Retry, `done` once its arrow was followed, `stopped` when a send back, the end or a
 * cancel stopped it.
 */
export type RoundState =
  | 'queued'
  | 'starting'
  | 'working'
  | 'picking'
  | 'reviewing'
  | 'person'
  | 'stuck'
  | 'done'
  | 'stopped'

export type StuckReason =
  | 'send_back_limit' // an arrow back was taken as often as it may be
  | 'no_report' // the session stopped without reporting, once after a reminder
  | 'no_pick' // the session stopped without picking, once after a reminder
  | 'picks_refused' // three picks in a row did not hold
  | 'session_gone' // its session was deleted
  | 'start_failed' // its session could not start
  | 'merge_failed' // merging a branch at the end conflicted or failed

/** What a round was sent back with, shown on top of its session and given to its agent. */
export interface SentBack {
  stepId: string // the step that sent it back, or its own for a review
  roundId: string
  outcome: string | null // null for a review sent back
  note: string | null
  /** The open comments on the document it handed in, for a review sent back. */
  comments: string[]
  by: 'agent' | 'person'
  /** Times this arrow was taken now, and how often it may be. */
  count: number
  limit: number
}

export interface RoundView {
  id: string
  stepId: string
  n: number // the step's round, from 1
  state: RoundState
  by: StepPick | null // null on a person's step
  pickedBy: PickedBy
  reason: string | null // why the picking agent chose it
  sessionId: string | null
  /** The branch it works on: the task's, or a parallel branch's; null outside Git. */
  branch: string | null
  queuedAt: number
  startedAt: number | null
  endedAt: number | null
  outcome: string | null
  note: string | null
  document: { artifactId: string; version: number; title: string } | null
  sentBack: SentBack | null
  stuck: { reason: StuckReason; detail: string | null } | null
  /** The session asks the person something: a permission, a question or a plan. */
  asking: boolean
  /** Branches still to merge at a join, and the files that conflict. */
  merge: { branches: string[]; conflicts: string[]; error: string | null } | null
}

/** Why a step that should start cannot. */
export type BlockedReason =
  | { kind: 'limit'; agentId: AgentId; resetsAt: number | null } // starts at the reset
  | {
      kind: 'unusable'
      agentId: AgentId
      why: 'disabled' | 'removed' | 'harness' | 'model' | 'effort' | 'no_kettu' | 'not_ready'
    }
  | { kind: 'no_agent' } // no agent Auto may pick
  | { kind: 'no_picker' } // no agent handed off to it, so it needs a pin
  | { kind: 'picking'; roundId: string } // waits for that round's agent to pick

/** A step waiting to start: at a join, for a pick, or blocked. */
export interface WaitingView {
  stepId: string
  since: number
  blocked: BlockedReason | null
  /** The pick it will start with, when one was made ahead. */
  pick: { by: StepPick; pickedBy: PickedBy; reason: string | null } | null
}

/** What waits for the person on a task, newest last; the sidebar's amber. */
export type TaskNeed =
  | { kind: 'person'; stepId: string; roundId: string }
  | { kind: 'review'; stepId: string; roundId: string }
  | { kind: 'asking'; stepId: string; roundId: string; sessionId: string }
  | { kind: 'blocked'; stepId: string; reason: BlockedReason }
  | { kind: 'stuck'; stepId: string; roundId: string; reason: StuckReason; detail: string | null }
  | { kind: 'end_merge'; stepId: string; conflicts: string[]; error: string | null }

/** An arrow the task took: solid lines on the flowchart; a send back counts its trips. */
export interface ArrowView {
  from: string
  outcome: string
  to: string[]
  back: boolean
  taken: number
  limit: number | null // for an arrow back
}

export interface TaskNote {
  at: number
  text: string
}

export interface TaskStepSummary {
  id: string
  name: string
  state: StepState
  rounds: number
  /** The agent of its latest round; null before one, or on a person's step. */
  agentId: AgentId | null
  sessionId: string | null
  startedAt: number | null
  endedAt: number | null
}

/** A task as the sidebar row and its hover card show it. */
export interface TaskSummary {
  id: string
  projectPath: string
  title: string
  workflowId: string
  workflowName: string
  status: TaskStatus
  end: TaskEnd | null
  steps: TaskStepSummary[]
  /** The step furthest along the workflow that started, 1-based, for step/total; null before any. */
  at: number | null
  needsYou: boolean
  error: boolean
  running: boolean
  /** The task's own branch and worktree; null outside Git. */
  branch: string | null
  worktreePath: string | null
  agents: AgentId[]
  pinnedAt: number | null
  archivedAt: number | null
  unread: boolean
  createdAt: number
  updatedAt: number
}

export interface TaskView extends TaskSummary {
  text: string
  pace: Pace
  paceReason: string | null
  /** The workflow as it was when the task started; later changes never reach it. */
  workflow: Workflow
  workflowHash: string
  pins: Record<string, StepPick>
  notes: TaskNote[]
  rounds: RoundView[]
  waiting: WaitingView[]
  arrows: ArrowView[]
  needs: TaskNeed[]
  /** The session whose agent suggested it, when it came from a suggestion card. */
  from: { sessionId: string } | null
}

export interface TaskStart {
  projectPath: string
  workflowId: string
  text: string
  title?: string
  pace: Pace
  paceReason?: string
  /** The first step's agent and its option values, as New session's tray chose them. */
  agentId: AgentId
  options: Record<string, string | boolean>
  /** Who does steps for this task only, by step id. */
  pins?: Record<string, StepPick>
  /** The task's worktree in a Git repository: the ref to cut from and its branch's name. */
  worktree?: { base: string; branch?: string }
}

/** A step session's link to its task, on its summary. */
export interface SessionTaskRef {
  taskId: string
  stepId: string
  roundId: string
}

// The checks Kettu shows on a report's or a pick's card.

export type ReportCheck =
  'step_open' | 'outcome' | 'note' | 'document' | 'committed' | 'merged' | 'picks'

export type PickCheck =
  'step' | 'agent' | 'allowed' | 'model' | 'effort' | 'tools' | 'limit' | 'review'

export interface CheckLine<C extends string> {
  check: C
  ok: boolean
  /** What did not hold, for the agent and the card. */
  detail: string | null
}

/** What happens after an accepted report or pick, for the card's last line. */
export type CheckNext =
  | { kind: 'review' } // the person reviews what it handed in
  | { kind: 'pick'; steps: string[] } // it picks who does these
  | { kind: 'start'; steps: string[] }
  | { kind: 'wait'; steps: string[] } // these wait for other branches
  | { kind: 'person'; steps: string[] }
  | { kind: 'end'; end: TaskEnd }
  | { kind: 'retry' } // refused: fix and report or pick again
  | { kind: 'stuck' } // refused too often: the task waits for the person

// Helpers both the host and its clients use.

/** The step's index in the workflow, -1 when it has none. */
export function stepIndex(workflow: Workflow, stepId: string): number {
  return workflow.steps.findIndex((step) => step.id === stepId)
}

/** Whether an outcome of `from` points back: to itself or an earlier step. */
export function isBackArrow(workflow: Workflow, from: string, outcome: WorkflowOutcome): boolean {
  const at = stepIndex(workflow, from)
  return outcome.to.some((to) => stepIndex(workflow, to) <= at)
}

/** Every arrow back the workflow draws, with how often it may be taken. */
export function backArrows(
  workflow: Workflow,
): { from: string; outcome: string; to: string[]; limit: number }[] {
  return workflow.steps.flatMap((step) =>
    step.outcomes
      .filter((outcome) => isBackArrow(workflow, step.id, outcome))
      .map((outcome) => ({
        from: step.id,
        outcome: outcome.name,
        to: [...outcome.to],
        limit: outcome.limit ?? workflow.sendBackLimit,
      })),
  )
}

/** A name from the workflow's locale for `locale`, falling back to the file's own. */
export function workflowText(
  workflow: Workflow,
  locale: string,
): { name: string; description: string } {
  const own = workflow.locales[locale]
  return { name: own?.name ?? workflow.name, description: own?.description ?? workflow.description }
}

export function stepName(workflow: Workflow, stepId: string, locale?: string): string {
  const own = locale === undefined ? undefined : workflow.locales[locale]?.steps?.[stepId]
  return own ?? workflow.steps.find((step) => step.id === stepId)?.name ?? stepId
}

const PICKED_KINDS: ReadonlySet<string> = new Set([
  'first',
  'task_pin',
  'workflow_pin',
  'agent',
  'previous',
  'person',
])

export function isPace(value: unknown): value is Pace {
  return PACES.includes(value as Pace)
}

export function isPickedBy(value: unknown): value is PickedBy {
  if (typeof value !== 'object' || value === null) return false
  const kind = (value as { kind?: unknown }).kind
  return typeof kind === 'string' && PICKED_KINDS.has(kind)
}

export function isStepPick(value: unknown): value is StepPick {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const pick = value as Record<string, unknown>
  const name = (v: unknown): boolean => v === null || (typeof v === 'string' && v.length <= 200)
  return isAgentId(pick.agentId) && name(pick.model) && name(pick.effort)
}
