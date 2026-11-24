// Workflows and the tasks that run through them: a workflow is a flowchart of steps, a task runs one
// requirement through it, each agent step in a session of its own. Shared by the agent host and
// its clients.

import { isAgentId } from './agents'
import type { CatalogServer, SkillSource } from './marketplace'
import type { AgentId } from './thread'

export const WORKFLOW_FORMAT = 1
export const WORKFLOW_FILE_BYTES = 256 * 1024
export const MAX_WORKFLOW_STEPS = 30
export const MAX_OUTCOMES = 8
export const MAX_TOOLS = 20
export const DEFAULT_SEND_BACK_LIMIT = 3
export const MAX_SEND_BACK_LIMIT = 20
/** Step sessions working at once in one task, so one task never holds every free session. */
export const MAX_TASK_STEPS = 3
/** Step sessions working at once across every task of the host, as the user may set it. */
export const WORKING_STEP_LIMITS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const
export type WorkingStepLimit = (typeof WORKING_STEP_LIMITS)[number]
export const DEFAULT_WORKING_STEPS: WorkingStepLimit = 6
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
  /** A role, by its reference, whose instructions the step's session is given. */
  role?: string
}

/** A workflow's text, step names and outcome names in another language. */
export interface WorkflowLocale {
  name?: string
  description?: string
  when?: string
  steps?: Record<string, string>
  /** By step id, each outcome's name in the file to its name here; shown only, never reported. */
  outcomes?: Record<string, Record<string, string>>
}

export interface Workflow {
  format: typeof WORKFLOW_FORMAT
  name: string
  description: string
  when?: string
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
export type WorkflowSource = 'github' | 'file' | 'agent' | 'user' | 'community' | 'plugin'

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
  // A plugin's workflow, by its name in the package; removed with the plugin.
  | { kind: 'plugin'; pluginId: string; name: string; plugin: string }

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
  /** The file on the host. */
  file: string
  addedAt: number | null
  /** Who does each step for every task of this workflow, by step id; Auto for the rest. */
  pins: Record<string, StepPick>
}

/**
 * Wire-only: the source and approval a host before v0.1.2 sends for the workflows it shipped with,
 * which start tasks without approval and have no file. No host sends it now; clients still read it
 * so they keep working with such a host.
 */
export const LEGACY_OFFICIAL = 'official'
export type LegacyOfficial = typeof LEGACY_OFFICIAL

/** A workflow entry as a client reads it from a host of any version. */
export interface WireWorkflowEntry extends Omit<WorkflowEntry, 'source' | 'approval' | 'file'> {
  source: WorkflowSource | LegacyOfficial
  approval: WorkflowApproval | LegacyOfficial
  /** Null for a workflow an older host shipped with. */
  file: string | null
}

/**
 * A workflow is usable for a new task: it reads, has no problem and is approved, or shipped with an
 * older host.
 */
export function usableWorkflow(
  entry: Pick<WireWorkflowEntry, 'workflow' | 'problems' | 'approval'>,
): boolean {
  return (
    entry.workflow !== null &&
    entry.problems.length === 0 &&
    (entry.approval === 'approved' || entry.approval === LEGACY_OFFICIAL)
  )
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

/** Files and links a report may hand over, and how long their text may be. */
export const MAX_STEP_DELIVERABLES = 10
export const DELIVERABLE_TITLE_CHARS = 120
export const DELIVERABLE_DETAIL_CHARS = 160
export const DELIVERABLE_PATH_CHARS = 1_024
export const DELIVERABLE_URL_CHARS = 2_048

/**
 * What a step hands over beside its document: a file it made, with its absolute path on the host,
 * or a link to where its work went, such as a store's build page.
 */
export type StepDeliverable =
  | { kind: 'file'; title: string; detail: string | null; path: string }
  | { kind: 'link'; title: string; detail: string | null; url: string }

/**
 * What a task delivered, as its page and the conversation it started from list it: the pull
 * requests of its steps, the latest document of each step, then the files and links they reported.
 */
export type TaskDeliverable =
  | { kind: 'pull_request'; url: string }
  | { kind: 'document'; artifactId: string; version: number; title: string }
  | StepDeliverable

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
  /** Absent from an older host. */
  deliverables?: StepDeliverable[]
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
  | { kind: 'tools'; missing: string[] } // named MCP servers or Skills not installed and on
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
  /** When it ended, done, dropped or cancelled; absent from an older host. */
  endedAt?: number | null
  /**
   * The session whose suggestion card started it, whose row it takes in the sidebar; absent from
   * an older host.
   */
  from?: { sessionId: string } | null
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
  /** What it delivered so far; absent from an older host. */
  deliverables?: TaskDeliverable[]
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

// Suggestions: the cards an agent's suggest_workflow and create_workflow show in its session.

/** Where a suggested workflow comes from. */
export type SuggestedSource =
  | { kind: 'library'; workflowId: string }
  | {
      kind: 'marketplace'
      listingId: string
      version: string
      handle: string
      slug: string
      official: boolean
      installs: number | null
    }
  // Written by the session's agent for this one requirement, kept outside the library.
  | { kind: 'draft'; draftId: string }

/** A tool a suggested workflow names, as its card shows it. */
export interface SuggestedTool {
  kind: 'mcp' | 'skill'
  /** As the workflow names it: a name the host keeps, or a Marketplace entry's id. */
  ref: string
  title: string
  description: string | null
  /** The server Start installs, or the one the host keeps; null for a skill. */
  server: CatalogServer | null
  /** The skill Start installs; null for a server or one the host keeps. */
  skill: SkillSource | null
  /** What the user does on the card before Start: sign in, fill in keys, or nothing. */
  setup: 'none' | 'sign-in' | 'keys'
}

/** One thing Start does, in the order it does them; the card ticks each off. */
export type StartItem =
  | { kind: 'connected'; ref: string; title: string } // a tool that signs in is connected
  | { kind: 'add'; name: string; version: string } // a Marketplace workflow goes into the library
  | { kind: 'install'; ref: string; tool: 'mcp' | 'skill'; title: string }
  | { kind: 'start'; step: string } // approves what the card drew and starts the task

export interface StartProgress {
  item: StartItem
  state: 'waiting' | 'running' | 'done' | 'failed'
  error: string | null
}

/**
 * The user's answer to a card, kept on the host: still waiting, Start under way, stopped at a
 * failed item, the task started, Do it here, or a workflow to keep saved or not.
 */
export type SuggestionAnswer =
  | { kind: 'waiting' }
  | { kind: 'starting' | 'failed'; items: StartProgress[] }
  | { kind: 'started'; taskId: string; items: StartProgress[] }
  | { kind: 'declined' }
  | { kind: 'saved'; workflowId: string }
  | { kind: 'not_saved' }

/** What the card says under the chart. */
export interface SuggestionFacts {
  /** How long the workflow took on this host, the middle of its finished runs; null before one. */
  pastMs: number | null
  runs: number
  /** The task works in a new worktree; false in the project folder; null for a workflow to keep. */
  worktree: boolean | null
}

/** A card as clients draw it. `purpose` save is a workflow written for the user to keep. */
export interface WorkflowSuggestion {
  id: string
  sessionId: string
  purpose: 'start' | 'save'
  source: SuggestedSource
  /** The workflow the card draws; Start and Save approve this and nothing else. */
  workflow: Workflow
  hash: string
  /** The library is short of an approval of this hash, so Start or Save approves it. */
  approves: boolean
  task: string
  title: string | null
  pace: Pace
  paceReason: string | null
  /** The agent that suggested or wrote it. */
  agentId: AgentId
  tools: SuggestedTool[]
  facts: SuggestionFacts
  answer: SuggestionAnswer
  /** Set when a paired device gave the answer. */
  device?: { id: string; name: string }
  createdAt: number
}

const SKILL_CATALOG_REF = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+:[A-Za-z0-9._-]+$/
const REGISTRY_REF = /^[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+$/
const KETTU_REF = /^kettu:[a-z2-7]{10}$/

/**
 * Whether a tool a workflow names is a Marketplace entry Start can install: a Kettu Marketplace
 * listing, an MCP Registry server's name or a skills catalog id, as the Marketplace keeps them.
 */
export function marketToolRef(kind: 'mcp' | 'skill', ref: string): boolean {
  if (KETTU_REF.test(ref)) return true
  return kind === 'mcp' ? REGISTRY_REF.test(ref) : SKILL_CATALOG_REF.test(ref)
}

/** The kept server or skill a workflow's name for it means: by its name, or its entry's id. */
export function keptTool<T extends { id: string; name: string }>(
  kept: readonly T[],
  ref: string,
): T | undefined {
  return kept.find((item) => item.name === ref) ?? kept.find((item) => item.id === ref)
}

/** A step session's link to its task, on its summary. */
export interface SessionTaskRef {
  taskId: string
  stepId: string
  roundId: string
}

// The checks Kettu shows on a report's or a pick's card.

export type ReportCheck =
  'step_open' | 'outcome' | 'note' | 'document' | 'deliverables' | 'committed' | 'merged' | 'picks'

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

// A file's maps are plain objects, so a key such as `constructor` must not reach their prototype.
function ownEntry<T>(map: Record<string, T> | undefined, key: string | undefined): T | undefined {
  return map !== undefined && key !== undefined && Object.hasOwn(map, key) ? map[key] : undefined
}

/** Text from the workflow's locale, falling back to the file's own field by field. */
export function workflowText(
  workflow: Pick<Workflow, 'name' | 'description' | 'when' | 'locales'>,
  locale: string,
): { name: string; description: string; when?: string } {
  const own = ownEntry(workflow.locales, locale)
  const when = own?.when ?? workflow.when
  return {
    name: own?.name ?? workflow.name,
    description: own?.description ?? workflow.description,
    ...(when === undefined ? {} : { when }),
  }
}

export function stepName(
  workflow: Pick<Workflow, 'locales'> & { steps: Pick<WorkflowStep, 'id' | 'name'>[] },
  stepId: string,
  locale?: string,
): string {
  const own = ownEntry(ownEntry(workflow.locales, locale)?.steps, stepId)
  return own ?? workflow.steps.find((step) => step.id === stepId)?.name ?? stepId
}

/**
 * An outcome's name in the workflow's locale, falling back to the file's own. Only for showing it:
 * a step reports, and a task stores, the file's own name.
 */
export function outcomeName(
  workflow: Pick<Workflow, 'locales'>,
  stepId: string,
  outcome: string,
  locale?: string,
): string {
  const step = ownEntry(ownEntry(workflow.locales, locale)?.outcomes, stepId)
  return ownEntry(step, outcome) ?? outcome
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
