import type { SessionSummary } from '@shared/agent-host'
import { create } from 'zustand'
import { archivedWith, treeIds } from '@renderer/app/actions'
import { listedSubSessions, sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import { workAtStake, type WorkItem } from './running-work'

export interface ArchiveAnswer {
  subSessions: boolean
}

/** A sub-session the question lists, with the first thing archiving it would stop in its tree. */
export interface SubSessionRow {
  summary: SessionSummary
  work: WorkItem | null
}

export type ArchiveQuestion = {
  answer: (answer: ArchiveAnswer | null) => void
} & (
  | {
      /** Whether the sub-sessions go too, which only the user can say. */
      kind: 'subSessions'
      /** The one session's title; null for several. */
      title: string | null
      sessions: number
      subSessions: SubSessionRow[]
      /** Whether each way stops running work: archiving alone stops the sessions' own. */
      stops: { all: boolean; alone: boolean }
    }
  | {
      /** The archive is decided, and stops these. */
      kind: 'running'
      items: WorkItem[]
      decided: ArchiveAnswer
    }
)

export const useArchiveQuestion = create<{ question: ArchiveQuestion | null }>(() => ({
  question: null,
}))

function ask(question: ArchiveQuestion): void {
  useArchiveQuestion.getState().question?.answer(null)
  useArchiveQuestion.setState({ question })
}

/**
 * How to archive these sessions, null being not at all. `subSessions` is the menu's choice; without
 * one, sessions with sub-sessions in the list ask whether they go too. A choice of all whose
 * sub-sessions run asks again, as keeping them is then the way not to stop them; any other archive
 * that stops running work, which archiving stops along with their terminals, asks to confirm it.
 */
export async function confirmArchive(
  sessionIds: readonly string[],
  subSessions?: boolean,
): Promise<ArchiveAnswer | null> {
  const { byId } = useSessionsStore.getState()
  const subs = sessionIds
    .flatMap((id) => listedSubSessions(byId, id))
    .sort((a, b) => a.createdAt - b.createdAt)
  const all = await workAtStake(sessionIds)
  const closing = new Set(archivedWith(sessionIds, false))
  const alone = all.filter((item) => item.sessionId !== null && closing.has(item.sessionId))
  const decided = { subSessions: subs.length === 0 || subSessions !== false }
  if (subs.length === 0 || subSessions === false || (subSessions === true && all.length === 0)) {
    const items = decided.subSessions ? all : alone
    if (items.length === 0) return decided
    return new Promise((answer) => ask({ kind: 'running', items, decided, answer }))
  }
  const only = sessionIds.length === 1 ? byId[sessionIds[0]!] : undefined
  const rows = subs.map((summary) => {
    const tree = new Set(treeIds(summary.id))
    const work = all.find((item) => item.sessionId !== null && tree.has(item.sessionId)) ?? null
    return { summary, work }
  })
  return new Promise((answer) =>
    ask({
      kind: 'subSessions',
      title: only ? sessionTitle(only) : null,
      sessions: sessionIds.length,
      subSessions: rows,
      stops: { all: all.length > 0, alone: alone.length > 0 },
      answer,
    }),
  )
}
