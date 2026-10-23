import type { SessionSummary } from '@shared/agent-host'
import type { MainView } from '@renderer/stores/view'

/**
 * What replaces the launch view once the sessions are in, unless something else was opened first:
 * the saved session, if allowed and still there, else New session.
 */
export function launchTarget({
  enabled,
  sessionId,
  main,
  byId,
}: {
  enabled: boolean
  sessionId: string | null
  main: MainView
  byId: Record<string, SessionSummary>
}): { kind: 'session'; summary: SessionSummary } | { kind: 'new' } | null {
  if (main.kind !== 'launch') return null
  const summary = enabled && sessionId ? byId[sessionId] : undefined
  return summary ? { kind: 'session', summary } : { kind: 'new' }
}
