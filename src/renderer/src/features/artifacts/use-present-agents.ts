import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { SessionSummary } from '@shared/agent-host'
import { useCloudOff } from '@renderer/lib/cloud'
import { hostOfSession, sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import { sharedPageVisitors, useSharingStore } from '@renderer/stores/sharing'
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
          hostId: hostOfSession(summaries[s.sessionId]!),
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

/** How often the viewer asks again how many people look at its published page. */
const VISITORS_EVERY_MS = 30_000

/**
 * How many people look at the artifact's page on Kettu now, asked while it is shown; null when it
 * is not published there or nobody can say.
 */
export function useVisitors(id: string): number | null {
  // Self-hosted, nothing asks Kettu's service.
  const cloudOff = useCloudOff()
  const published = useSharingStore(
    (s) =>
      s.status?.published.some((p) => p.id === id && p.target === 'kettu' && !p.otherAccount) ??
      false,
  )
  const onKettu = published && !cloudOff
  const [counted, setCounted] = useState<{ id: string; count: number | null } | null>(null)
  useEffect(() => {
    if (!onKettu) return
    let live = true
    const ask = () =>
      void sharedPageVisitors(id).then((count) => {
        if (live) setCounted({ id, count })
      })
    ask()
    const timer = setInterval(ask, VISITORS_EVERY_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [id, onKettu])
  return onKettu && counted?.id === id ? counted.count : null
}
