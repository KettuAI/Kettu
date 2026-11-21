import type { SessionSummary } from '@shared/agent-host'
import { subagentRunning } from '@renderer/features/session/subagent/progress'

/**
 * The sub-agents a session's badge lists: those running, the latest started first, then with
 * `showFinished` the others, the latest finished first.
 */
export function listedSubagents(
  subagents: readonly SessionSummary[],
  showFinished: boolean,
): SessionSummary[] {
  const running = subagents.filter(subagentRunning).sort((a, b) => b.createdAt - a.createdAt)
  if (!showFinished) return running
  const finished = subagents
    .filter((subagent) => !subagentRunning(subagent))
    .sort((a, b) => b.updatedAt - a.updatedAt)
  return [...running, ...finished]
}

/** A sub-agent that failed, or needs a look for an error. */
export function subagentFailed(child: Pick<SessionSummary, 'attention' | 'status'>): boolean {
  return child.attention === 'error' || child.status === 'failed'
}
