// What a routine's run needs of the session that carries it, and what it hears back.

import type { PermissionScope, RoutineRef } from '@shared/routines'
import type { AgentId, StopReason, TokenTotals } from '@shared/thread'
import type { SessionSummary } from '@shared/agent-host'

/** How a run's first turn ended, as the session reports it. */
export interface RunTurnResult {
  /** null when the turn failed before a stop reason. */
  stopReason: StopReason | null
  error: { message: string; detail?: string } | null
  output: string | null // the turn's answer, up to 64 KB
  usage: TokenTotals | null // the turn's token counts
  changedFiles: string[] // the locations of its edits, relative to the project
}

/** What the routines manager hears of the sessions its runs use. */
export interface RoutineSessionHooks {
  /** The run's session exists, before anything is sent. */
  sessionCreated(sessionId: string, routine: RoutineRef): void
  /** Its first turn started. */
  turnStarted(sessionId: string): void
  /** A permission request waits in it, or the last one was answered; `title` names the tool. */
  waiting(sessionId: string, waiting: boolean, title?: string): void
  /** Its first turn ended. */
  turnEnded(sessionId: string, result: RunTurnResult): void
  /** The session left the index: its run keeps the record without it. */
  sessionGone(sessionId: string): void
}

/** The hooks are set once the routines manager exists, after the sessions manager. */
export interface RoutineSessionHooksRef {
  current: RoutineSessionHooks | null
}

export interface RoutineSessionStart {
  agentId: AgentId
  projectPath: string // an existing folder: the routine's project or its scratch folder
  options: Record<string, string | boolean>
  prompt: string
  routine: RoutineRef
  /** What the run may do without asking. */
  scope: PermissionScope
  /** The mode its level names for the agent; null when the agent offers no modes. */
  mode: string | null
}

/** What the routines manager needs of the sessions manager. */
export interface RoutineSessions {
  createRun(params: RoutineSessionStart): Promise<SessionSummary>
  cancel(sessionId: string): Promise<void>
  delete(sessionId: string): Promise<void>
  has(sessionId: string): boolean
  summary(sessionId: string): SessionSummary | null
}
