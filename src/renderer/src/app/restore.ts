import type { SessionSummary } from '@shared/agent-host'
import type { MainView } from '@renderer/stores/view'

/** The session to reopen at launch: the saved one, if allowed, still there, and nothing else opened. */
export function sessionToRestore({
  enabled,
  sessionId,
  main,
  byId,
}: {
  enabled: boolean
  sessionId: string | null
  main: MainView
  byId: Record<string, SessionSummary>
}): SessionSummary | null {
  if (!enabled || !sessionId || main.kind !== 'home') return null
  return byId[sessionId] ?? null
}
