// SOPs and the tasks that run through them: an SOP is a flowchart of steps, a task runs one
// requirement through it, each agent step in a session of its own. Shared by the agent host and
// its clients.

import { isAgentId } from './agents'
import type { AgentId } from './thread'

export const SOP_FORMAT = 1
export const SOP_FILE_BYTES = 256 * 1024
export const MAX_SOP_STEPS = 30
export const MAX_OUTCOMES = 8
export const MAX_TOOLS = 20
export const DEFAULT_SEND_BACK_LIMIT = 3
export const MAX_SEND_BACK_LIMIT = 20
/** Step sessions working at once, across every task of the host. */
export const MAX_WORKING_STEPS = 3
export const SOP_NAME_CHARS = 80
export const SOP_DESCRIPTION_CHARS = 2_000
export const STEP_PROMPT_CHARS = 20_000
export const STEP_HINT_CHARS = 500
export const SOP_ID_CHARS = 64
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
export interface SopOutcome {
  name: string
  /** The steps it starts, several at once for parallel work; empty when it ends the task. */
  to: string[]
  end: TaskEnd | null
  /** This arrow's own send-back limit, when it points back; the SOP's otherwise. */
  limit: number | null
}

/** The MCP servers and Skills a step's session is handed, by the names Kettu knows them by. */
export interface StepTools {
  mcp: string[]
  skills: string[]
}

export interface SopStep {
  id: string
  name: string
  /** What to do; on a person's step, what to ask them. */
  prompt: string
  by: StepBy
  handIn: HandIn
  outcomes: SopOutcome[]
  /** The person approves what it hands in before its arrow is followed. */
  youReview: boolean
  /** Free text for whoever picks the step's agent. */
  hint: string | null
  /** The steps it reviews, whose agent and model it must not share. */
  reviewOf: string[]
  tools: StepTools
}

/** An SOP's name, description and step names in another language. */
export interface SopLocale {
  name?: string
  description?: string
  steps?: Record<string, string>
}

export interface Sop {
  format: typeof SOP_FORMAT
  name: string
  description: string
  locales: Record<string, SopLocale>
  sendBackLimit: number
  /** In forward order; the first is the start. An arrow to itself or an earlier step sends back. */
  steps: SopStep[]
}

/** Where the validator found a problem: a path such as `steps[2].outcomes[0].to`, and why. */
export interface SopProblem {
  at: string
  message: string
}

// The library.

/** Official SOPs ship with Kettu; the rest are the user's, by how they came. */
export type SopSource = 'official' | 'github' | 'file' | 'agent' | 'user'

export type SopOrigin =
  | { kind: 'github'; url: string } // the file's page or raw URL as given
  | { kind: 'file'; name: string } // the file name the user picked
  | { kind: 'agent'; sessionId: string; agentId: AgentId }

/**
 * Whether an SOP may start tasks: an official one always; one of the library only while its
 * content is the one the user approved. `changed` was approved, then changed.
 */
export type SopApproval = 'official' | 'approved' | 'pending' | 'changed'

/** Who does a step: an agent with its model and effort; null ones leave the agent's own. */
export interface StepPick {
  agentId: AgentId
  model: string | null
  effort: string | null
}

export interface SopEntry {
  id: string
  source: SopSource
  /** Null when the file does not read; `problems` says why. */
  sop: Sop | null
  /** The SOP's name, or the file's when it does not read. */
  name: string
  /** Empty for one that can be used; the tools' names are checked against the host's. */
  problems: SopProblem[]
  approval: SopApproval
  /** SHA-256 of the file as read, hex; what an approval names. */
  hash: string
  origin: SopOrigin | null
  /** The file on the host; null for an official SOP. */
  file: string | null
  addedAt: number | null
  /** Who does each step for every task of this SOP, by step id; Auto for the rest. */
  pins: Record<string, StepPick>
}

/** An SOP is usable for a new task: it reads, has no problem and is approved. */
export function usableSop(entry: SopEntry): boolean {
  return (
    entry.sop !== null &&
    entry.problems.length === 0 &&
    (entry.approval === 'official' || entry.approval === 'approved')
  )
}

export interface SopSettings {
  /** Agents of ordinary sessions see list_sops and start_sop. */
  suggest: boolean
  /** The Claude Code and Codex agents and whether Auto may pick them; disabled ones are left out. */
  agents: { agentId: AgentId; allowed: boolean; byDefault: boolean }[]
}

export interface SopSettingsChange {
  suggest?: boolean
  /** By agent; null goes back to the default: subscriptions on, API keys off. */
  autoPick?: Partial<Record<AgentId, boolean | null>>
}

export type SopAddSource =
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
  | { kind: 'sop_pin' }
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
  sopId: string
  sopName: string
  status: TaskStatus
  end: TaskEnd | null
  steps: TaskStepSummary[]
  /** The step furthest along the SOP that started, 1-based, for step/total; null before any. */
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
  /** The SOP as it was when the task started; later changes never reach it. */
  sop: Sop
  sopHash: string
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
  sopId: string
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

/** The step's index in the SOP, -1 when it has none. */
export function stepIndex(sop: Sop, stepId: string): number {
  return sop.steps.findIndex((step) => step.id === stepId)
}

/** Whether an outcome of `from` points back: to itself or an earlier step. */
export function isBackArrow(sop: Sop, from: string, outcome: SopOutcome): boolean {
  const at = stepIndex(sop, from)
  return outcome.to.some((to) => stepIndex(sop, to) <= at)
}

/** Every arrow back the SOP draws, with how often it may be taken. */
export function backArrows(
  sop: Sop,
): { from: string; outcome: string; to: string[]; limit: number }[] {
  return sop.steps.flatMap((step) =>
    step.outcomes
      .filter((outcome) => isBackArrow(sop, step.id, outcome))
      .map((outcome) => ({
        from: step.id,
        outcome: outcome.name,
        to: [...outcome.to],
        limit: outcome.limit ?? sop.sendBackLimit,
      })),
  )
}

/** A name from the SOP's locale for `locale`, falling back to the file's own. */
export function sopText(sop: Sop, locale: string): { name: string; description: string } {
  const own = sop.locales[locale]
  return { name: own?.name ?? sop.name, description: own?.description ?? sop.description }
}

export function stepName(sop: Sop, stepId: string, locale?: string): string {
  const own = locale === undefined ? undefined : sop.locales[locale]?.steps?.[stepId]
  return own ?? sop.steps.find((step) => step.id === stepId)?.name ?? stepId
}

const PICKED_KINDS: ReadonlySet<string> = new Set([
  'first',
  'task_pin',
  'sop_pin',
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
