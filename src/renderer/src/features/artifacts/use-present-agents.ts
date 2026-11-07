import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { SessionSummary } from '@shared/agent-host'
import { sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import type { CanvasAgent } from './canvas-editor'
import type { Presence } from './use-artifact'

/** The sessions using an artifact that this window knows, with their titles and agents. */
export function usePresentAgents(presence: Presence | null, deleted: boolean): CanvasAgent[] {
  const sessions = useMemo(() => (deleted ? [] : (presence?.sessions ?? [])), [presence, deleted])
  const summaries = useSessionsStore(
    useShallow((s) => {
      const known: Record<string, SessionSummary> = {}
      for (const session of sessions) {
        const summary = s.byId[session.sessionId]
        if (summary) known[session.sessionId] = summary
      }
      return known
    }),
  )
  const { t } = useTranslation('common')
  return useMemo(
    () =>
      sessions
        .filter((s) => summaries[s.sessionId])
        .map((s) => ({
          sessionId: s.sessionId,
          name: summaries[s.sessionId]!.title ?? t('untitledSession'),
          agentId: summaries[s.sessionId]!.agentId,
          doing: s.doing ?? (s.editing ? 'write' : 'read'),
          focus: s.focus ?? null,
        })),
    [sessions, summaries, t],
  )
}

/**
 * The name a note an agent drew shows: its session's title, whether or not the session is still
 * here; `fallback` when this window does not know the session.
 */
export function noteAuthor(
  agents: readonly CanvasAgent[],
  session: string,
  fallback: string,
): string {
  const here = agents.find((a) => a.sessionId === session)
  if (here) return here.name
  const summary = useSessionsStore.getState().byId[session]
  return summary ? sessionTitle(summary) : fallback
}
