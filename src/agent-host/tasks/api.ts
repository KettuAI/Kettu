// The seams between the task engine and the rest of the host: what the engine stores, what it
// asks of sessions, worktrees and git (TaskRuntime), and what the host tells it (TaskEngineApi).

import type { PlanLimit } from '@shared/agent-host'
import type { PermissionScope } from '@shared/routines'
import type {
  StageRunView,
  TaskDecision,
  TaskDraft,
  TaskView,
  TierSettings,
  Workflow,
  WorkflowSource,
  WorkflowSummary,
} from '@shared/tasks'
import type { AgentId } from '@shared/thread'
import type { WorktreeRecord } from '../storage'

/** A task as stored: the view plus what only the host keeps. */
export interface TaskRecord extends Omit<TaskView, 'workflow' | 'stages' | 'worktree'> {
  workflow: TaskView['workflow']
  /** The workflow as it was when the task was created; later edits never reach it. */
  snapshot: Workflow
  /** Rounds used per rework edge, by the stage the edge leaves from. */
  rounds: Record<string, number>
  worktree: WorktreeRecord | null
  /** Set by the person's pause, which only the person lifts. */
  pausedByUser: boolean
  /** Notes for the next round of the current stage: a send-back's or the person's; null once sent. */
  notes: string | null
}

export type StageRunRecord = StageRunView & {
  /** The turn count of the session when the round began, so evidence counts this round only. */
  fromTurn: number
  /** The agent was reminded once to submit after a turn ended without a result. */
  nudged: boolean
  /** Working milliseconds so far, for the stage time limit; waiting on the person does not count. */
  workedMs: number
  /** The submission asked for a stronger tier next round. */
  escalate?: boolean
}

export interface TasksFile {
  version: 1
  tasks: TaskRecord[]
  runs: StageRunRecord[]
  tiers: TierSettings | null // null until the user saves their own; defaults come from agents
}

/** What the submit tool hands the engine, already shape-checked against its schema. */
export interface StageSubmission {
  verdict: 'pass' | 'changes' | 'blocked'
  summary: string
  fields: Record<string, string | string[] | boolean>
  /** The agent asks for a stronger tier next round; the engine decides. */
  escalate?: boolean
}

/** The engine's answer to a submission: accepted, or refused with what to fix (shown to the agent). */
export type SubmitAnswer = { ok: true; next: string } | { ok: false; error: string }

/** What a stage session did during a round, from its tool calls, never from its words. */
export interface StageEvidence {
  commands: string[] // every command it executed, as run
  changedFiles: string[] // paths relative to the worktree
  turns: number // turns the session has had in all
  costUsd?: number // estimated cost of the turns since `fromTurn`, when known
}

/** An installed agent the tiers may pick, and its plan limits. */
export interface TaskAgent {
  agentId: AgentId
  harness: string // 'claude-code', 'codex', ...
  enabled: boolean
  /** Only harnesses whose permission flow Kettu controls may run stages. */
  canRunStages: boolean
  limits: PlanLimit[]
}

export interface OpenStageSession {
  task: TaskRecord
  run: StageRunRecord
  agentId: AgentId
  options: Record<string, string | boolean>
  prompt: string
  scope: PermissionScope
  title: string
}

/** What the engine needs from the rest of the host. Faked in the engine's tests. */
export interface TaskRuntime {
  now(): number
  agents(): TaskAgent[]
  /** Makes the task's worktree from `base` (the project's default branch when null). */
  createWorktree(task: TaskRecord, base: string | null): Promise<WorktreeRecord>
  /** Opens a stage session in the task's worktree (or project folder) with the first message. */
  openSession(params: OpenStageSession): Promise<{ sessionId: string; model: string | null }>
  /** Sends a follow-up to a stage session, reviving it when closed; queues while it works. */
  send(sessionId: string, text: string): Promise<void>
  /** Stops the session's turn, as Stop does. */
  stop(sessionId: string): Promise<void>
  /** Whether the session still exists and can be sent to. */
  alive(sessionId: string): boolean
  evidence(sessionId: string, fromTurn: number): Promise<StageEvidence>
  turns(sessionId: string): number
  /** Pushes the task's branch and opens a pull request; its URL. */
  handover(task: TaskRecord, summary: string): Promise<string>
  /** Tells the person: a task needs them, finished or was blocked. */
  notify(task: TaskView, kind: 'needs-you' | 'done' | 'blocked'): void
  /** Reads the workflow the task names, fresh, for creation only. */
  workflow(
    projectPath: string,
    source: WorkflowSource,
    id: string,
  ): Promise<{ workflow: Workflow; hash: string }>
  workflows(projectPath: string | null): Promise<WorkflowSummary[]>
}

/** What the host calls on the engine. */
export interface TaskEngineApi {
  load(): Promise<void>
  list(): TaskView[]
  get(taskId: string): { task: TaskView; runs: StageRunView[] }
  create(draft: TaskDraft, by: 'user' | 'agent'): Promise<TaskView>
  start(taskId: string): TaskView
  pause(taskId: string): TaskView
  resume(taskId: string): TaskView
  cancel(taskId: string): Promise<TaskView>
  decide(decision: TaskDecision): Promise<TaskView>
  markSeen(taskId: string): void
  tiers(): TierSettings
  setTiers(tiers: TierSettings): TierSettings
  /** From the submit tool of a stage session; `sessionId` is the caller the token names. */
  submit(sessionId: string, submission: StageSubmission): Promise<SubmitAnswer>
  /** Whether a session belongs to a task's agent stage, and which: gates the submit tool. */
  stageOf(sessionId: string): { taskId: string; runId: string; stageId: string } | null
  /** Session lifecycle the host reports for stage sessions. */
  turnEnded(sessionId: string): void
  waiting(sessionId: string, waiting: boolean): void
  sessionGone(sessionId: string): void
  limitsChanged(agentId: AgentId): void
  power(state: 'suspend' | 'resume'): void
  flush(): Promise<void>
}

export interface TaskEvents {
  changed(task: TaskView): void
  removed(taskId: string): void
  run(run: StageRunView): void
}
