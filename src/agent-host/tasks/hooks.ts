// What a task's node needs of the session that carries it, and what the engine hears back.

import type { AgentId } from '@shared/thread'
import type { SessionTaskRef, WorktreeRecord } from '../storage'

/** What the task engine hears of its node sessions, on every turn. */
export interface TaskSessionHooks {
  /** Whether the session works for a node that has not reported, so its scope and silence apply. */
  isNode(sessionId: string): boolean
  turnEnded(sessionId: string): void
  /** A request waits for the person in the session, or the last one was answered. */
  waiting(sessionId: string, waiting: boolean): void
  /** The session left the index. */
  sessionGone(sessionId: string): void
}

/** Set once the task engine exists, after the sessions manager. */
export interface TaskSessionHooksRef {
  current: TaskSessionHooks | null
}

export interface TaskNodeStart {
  agentId: AgentId
  projectPath: string
  /** The worktree the node's run works in, the task's or a branch's own; null for the project. */
  worktree: WorktreeRecord | null
  options: Record<string, string | boolean>
  prompt: string
  title: string
  task: SessionTaskRef
  /** The mode its scope's level names for the agent; null when the agent offers no modes. */
  mode: string | null
}
