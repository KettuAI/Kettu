import type { SessionSummary } from '@shared/agent-host'
import type { MainView } from '@renderer/stores/view'

/**
 * What replaces the launch view once the sessions are in, unless something else was opened first:
 * the saved session, if allowed and still there, else New session while there are projects. Null
 * keeps Welcome.
 */
export function launchTarget({
  enabled,
  sessionId,
  main,
  byId,
  hasProjects,
}: {
  enabled: boolean
  sessionId: string | null
  main: MainView
  byId: Record<string, SessionSummary>
  hasProjects: boolean
}): { kind: 'session'; summary: SessionSummary } | { kind: 'new' } | null {
  if (main.kind !== 'welcome') return null
  const summary = enabled && sessionId ? byId[sessionId] : undefined
  if (summary) return { kind: 'session', summary }
  return hasProjects ? { kind: 'new' } : null
}
