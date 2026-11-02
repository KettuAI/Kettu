import type { ImportableSession } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import { monthDay } from '@renderer/lib/format'
import { i18n } from '@renderer/lib/i18n'

/** One agent's sessions for the folder, as far as its pages have come. */
export interface AgentList {
  sessions: ImportableSession[]
  nextCursor: string | null
  loading: boolean
  error: string | null
}

export type AgentLists = Partial<Record<AgentId, AgentList>>

/** A listed session's key in the selection; two agents may use the same session id. */
export function importKey(agentId: AgentId, acpSessionId: string): string {
  return `${agentId}\n${acpSessionId}`
}

/** Whether the list came, so its count is known. */
export function listed(list: AgentList | undefined): list is AgentList {
  return !!list && !list.error && !(list.loading && list.sessions.length === 0)
}

/** The keys of a list's sessions that are not in Kettu yet, in its order. */
export function importableKeys(agentId: AgentId, list: AgentList | undefined): string[] {
  return (list?.sessions ?? [])
    .filter((s) => !s.imported)
    .map((s) => importKey(agentId, s.acpSessionId))
}

/**
 * The agent whose tab shows: the one chosen, else the first whose list is not known to be empty,
 * so a list that is still loading keeps its place and an empty one gives way to the next.
 */
export function shownAgent(
  agents: readonly AgentId[],
  lists: AgentLists,
  chosen: AgentId | null,
): AgentId | null {
  if (chosen && agents.includes(chosen)) return chosen
  const empty = (id: AgentId) => {
    const list = lists[id]
    return listed(list) && list.sessions.length === 0 && !list.nextCursor
  }
  return agents.find((id) => !empty(id)) ?? agents[0] ?? null
}

/** Whether every key is selected; false with none to select. */
export function allSelected(keys: readonly string[], selected: ReadonlySet<string>): boolean {
  return keys.length > 0 && keys.every((key) => selected.has(key))
}

/** The selection with the keys added, or taken out. */
export function withKeys(
  selected: ReadonlySet<string>,
  keys: readonly string[],
  on: boolean,
): Set<string> {
  const next = new Set(selected)
  for (const key of keys) {
    if (on) next.add(key)
    else next.delete(key)
  }
  return next
}

/** The selected sessions still to import, in the tabs' order, then each list's. */
export function selectedSessions(
  agents: readonly AgentId[],
  lists: AgentLists,
  selected: ReadonlySet<string>,
): { agentId: AgentId; acpSessionId: string }[] {
  return agents.flatMap((agentId) =>
    (lists[agentId]?.sessions ?? [])
      .filter((s) => !s.imported && selected.has(importKey(agentId, s.acpSessionId)))
      .map((s) => ({ agentId, acpSessionId: s.acpSessionId })),
  )
}

/** The lists with one session marked as imported. */
export function markImported(
  lists: AgentLists,
  agentId: AgentId,
  acpSessionId: string,
): AgentLists {
  const list = lists[agentId]
  if (!list) return lists
  return {
    ...lists,
    [agentId]: {
      ...list,
      sessions: list.sessions.map((s) =>
        s.acpSessionId === acpSessionId ? { ...s, imported: true } : s,
      ),
    },
  }
}

/**
 * Runs `run` on each item, one finishing before the next starts, since the host imports one
 * session per call; stops before the next once `going` turns false. Returns the items that failed.
 */
export async function importInOrder<T>(
  items: readonly T[],
  run: (item: T) => Promise<boolean>,
  going: () => boolean,
): Promise<T[]> {
  const failed: T[] = []
  for (const item of items) {
    if (!going()) break
    if (!(await run(item))) failed.push(item)
  }
  return failed
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY

/** When a listed session last changed: "3 d ago", "2 w ago", then its date. */
export function sessionAgo(at: number, now = Date.now()): string {
  const delta = Math.max(0, now - at)
  const ago = (unit: 'minutes' | 'hours' | 'days' | 'weeks', size: number) =>
    i18n.t(`sidebar:import.ago.${unit}`, { count: Math.floor(delta / size) })
  if (delta < MINUTE) return i18n.t('sidebar:import.ago.now')
  if (delta < HOUR) return ago('minutes', MINUTE)
  if (delta < DAY) return ago('hours', HOUR)
  if (delta < WEEK) return ago('days', DAY)
  if (delta < 5 * WEEK) return ago('weeks', WEEK)
  return monthDay(at)
}
