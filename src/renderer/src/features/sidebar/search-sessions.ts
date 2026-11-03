/** How many sessions Search lists before anything is typed. */
export const RECENT_LIMIT = 8

/** One session Search can offer. Message text is not here; that search is separate. */
export interface SessionSearchInput {
  id: string
  title: string
  project: string
  /** Set only when more than this computer is connected, so one host is not named on every row. */
  host: string | null
  branch: string | null
  /** A subagent's purpose, when it has one. */
  detail: string | null
  updatedAt: number
}

/**
 * Sessions matching every word, most recently updated first. An empty query is the recent few,
 * not the whole list. Matching ignores case and covers the title, project, host, branch and detail.
 */
export function searchSessions<T extends SessionSearchInput>(
  sessions: readonly T[],
  query: string,
): T[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const ranked = sessions.toSorted((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
  if (words.length === 0) return ranked.slice(0, RECENT_LIMIT)
  return ranked.filter((session) => words.every((word) => haystack(session).includes(word)))
}

function haystack(session: SessionSearchInput): string {
  return [
    session.title,
    session.project,
    session.host ?? '',
    session.branch ?? '',
    session.detail ?? '',
  ]
    .join('\n')
    .toLocaleLowerCase()
}
