// The seams between the task engine and the rest of the host: what the engine stores, what it
// asks of sessions, worktrees and git (TaskRuntime), and what the host tells it (TaskEngineApi).

import type {
  NodeRunView,
  Sop,
  SopSource,
  SopSummary,
  TaskDecision,
  TaskDraft,
  TaskRetry,
  TaskView,
  TierSettings,
  TierState,
} from '@shared/tasks'
import type { AgentId } from '@shared/thread'
import type { WorktreeRecord } from '../storage'

/**
 * One line of work moving through the SOP. A task starts with one; an outcome that leads to
 * several nodes splits it into one per node, and a node several of them reach joins them again.
 */
export interface TokenRecord {
  id: string // 'tk-' and 12 hex digits
  /** The node it is at: working there (`runId` set), or arrived and waiting for the others. */
  nodeId: string
  runId: string | null
  /**
   * The worktrees it works in, outermost first: the task's own, then one per split it came
   * through. Empty when the task has no worktree. It works in the last.
   */
  lanes: WorktreeRecord[]
  /** How it got here: the node and outcome before, with the note; null at the start. */
  from: { nodeId: string; outcome: string; note: string; back: boolean } | null
}

/** A task as stored: the view plus what only the host keeps. */
export interface TaskRecord extends Omit<
  TaskView,
  'outline' | 'worktree' | 'needsYou' | 'arrived'
> {
  /** The SOP as it was when the task was created; later edits never reach it. */
  snapshot: Sop
  worktree: WorktreeRecord | null
  tokens: TokenRecord[]
  /** Times each arrow back was taken, by `<node>/<outcome>`. */
  rounds: Record<string, number>
  /** Worktrees of branches that were merged or given up, to remove when the task ends. */
  spent: { worktree: WorktreeRecord; merged: boolean }[]
}

export type NodeRunRecord = Omit<NodeRunView, 'hasDocument' | 'worktree'> & {
  /** The Markdown handed in; null for none. */
  document: string | null
  worktree: WorktreeRecord | null
  /** The agent was reminded once to report after a turn ended without one. */
  reminded: boolean
  /** Branches to merge into its worktree before it may report, when a merge stopped on conflicts. */
  toMerge: WorktreeRecord[]
}

export interface TasksFile {
  version: 2
  tasks: TaskRecord[]
  runs: NodeRunRecord[]
  tiers: TierSettings
}

/** What the report tool hands the engine, already shape-checked against its schema. */
export interface NodeReport {
  outcome: string
  /** What was done, or the reason for the outcome. */
  note: string
  document?: string
}

/** The engine's answer to a report: taken, or refused with what to fix (shown to the agent). */
export type ReportAnswer = { ok: true; next: string } | { ok: false; error: string }

/** An installed agent a tier may stand for. */
export interface TaskAgent {
  agentId: AgentId
  harness: string // 'claude-code', 'codex', ...
  enabled: boolean
  /** Only harnesses whose permission flow Kettu controls may run nodes. */
  canRunNodes: boolean
}

export interface OpenNodeSession {
  task: TaskRecord
  run: NodeRunRecord
  agentId: AgentId
  options: Record<string, string | boolean>
  prompt: string
  title: string
  /** Where it works; null for the project folder. */
  worktree: WorktreeRecord | null
}

/** What the engine needs from the rest of the host. Faked in the engine's tests. */
export interface TaskRuntime {
  now(): number
  agents(): TaskAgent[]
  /** Makes the task's worktree from the project's default branch; null when the project has no git. */
  createWorktree(task: TaskRecord): Promise<WorktreeRecord | null>
  /** Makes a branch's own worktree from the head of `from`. */
  forkWorktree(task: TaskRecord, from: WorktreeRecord, label: string): Promise<WorktreeRecord>
  /** Whether the worktree has nothing uncommitted and no merge under way. */
  clean(worktree: WorktreeRecord): Promise<boolean>
  /**
   * Merges the branch of `from` into `into`. On conflicts: with `leave` the merge stays under
   * way in `into` for an agent to finish, without it the merge is undone. Rejects when it
   * cannot start.
   */
  merge(into: WorktreeRecord, from: WorktreeRecord, leave: boolean): Promise<'merged' | 'conflict'>
  /** Whether everything on the branch of `from` is in `into`. */
  merged(into: WorktreeRecord, from: WorktreeRecord): Promise<boolean>
  /** Removes a branch's worktree, and its branch too when `merged`; never rejects. */
  removeWorktree(task: TaskRecord, worktree: WorktreeRecord, merged: boolean): Promise<void>
  /** Opens a node's session with its first message. */
  openSession(params: OpenNodeSession): Promise<{ sessionId: string; model: string | null }>
  /** Sends a follow-up to a node session, reviving it when closed; queues while it works. */
  send(sessionId: string, text: string): Promise<void>
  /** Stops the session's turn, as Stop does. */
  stop(sessionId: string): Promise<void>
  /** Whether the session still exists and can be sent to. */
  alive(sessionId: string): boolean
  /** Whether the session is in a turn now. */
  working(sessionId: string): boolean
  /** Tells the person: a task needs them, or ended. */
  notify(task: TaskView, kind: 'needs-you' | 'done'): void
  /** Reads an SOP a task may start with, fresh; rejects for one that is missing, broken or pending. */
  sop(source: SopSource, id: string): Promise<{ sop: Sop; hash: string }>
}

/** What the host calls on the engine. */
export interface TaskEngineApi {
  load(): Promise<void>
  list(): TaskView[]
  get(taskId: string): { task: TaskView; runs: NodeRunView[] }
  /** Creates the task and starts its first node. */
  create(draft: TaskDraft, by: 'user' | 'agent'): Promise<TaskView>
  cancel(taskId: string): Promise<TaskView>
  /** Removes an ended task; its sessions stay as plain sessions. */
  remove(taskId: string): Promise<void>
  decide(decision: TaskDecision): Promise<TaskView>
  retry(retry: TaskRetry): Promise<TaskView>
  markSeen(taskId: string): void
  document(runId: string): string | null
  tiers(): TierState
  setTiers(tiers: TierSettings): TierState
  /** From the report tool of a node session; `sessionId` is the caller the token names. */
  report(sessionId: string, report: NodeReport): Promise<ReportAnswer>
  /** The node a session is working on now; null once it reported, so its scope lapses. */
  nodeOf(sessionId: string): { taskId: string; runId: string; nodeId: string } | null
  /** Session lifecycle the host reports for node sessions. */
  turnEnded(sessionId: string): void
  waiting(sessionId: string, waiting: boolean): void
  sessionGone(sessionId: string): void
  flush(): Promise<void>
}

export interface TaskEvents {
  changed(task: TaskView): void
  removed(taskId: string): void
  run(run: NodeRunView): void
}

/** The user's SOP library and the ones shipped with Kettu. */
export interface SopLibraryApi {
  list(): Promise<SopSummary[]>
  /** For starting a task: rejects for one that is missing, broken or pending. */
  read(source: SopSource, id: string): Promise<{ sop: Sop; hash: string }>
  /** Saves an SOP an agent or the person wrote; it is pending until approved. Rejects when invalid. */
  add(text: string, by: 'agent' | 'user'): Promise<SopSummary>
  /** The person approves the library file as it is now. */
  approve(id: string, hash: string): Promise<SopSummary>
  remove(id: string): Promise<void>
}
