import type { SessionSummary } from '@shared/agent-host'
import { useSessionsStore } from '@renderer/stores/sessions'

/**
 * The folder a session works in: its worktree's when it has one, else its project's. Its project
 * stays what it is grouped and named by.
 */
export function sessionFolder(
  // `scratch` is there so a thread's view, which carries no worktree, is never passed by mistake.
  summary: Pick<SessionSummary, 'projectPath' | 'worktree' | 'scratch'>,
): string {
  return summary.worktree ? summary.worktree.path : summary.projectPath
}

/** The folder the session works in, or null while it is unknown. */
export function useSessionFolder(sessionId: string | null): string | null {
  return useSessionsStore((s) => {
    const summary = sessionId ? s.byId[sessionId] : undefined
    return summary ? sessionFolder(summary) : null
  })
}
