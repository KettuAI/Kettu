import type { ImportableSession } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import { monthDay } from '@renderer/lib/format'
import { hostOfPath, hostPath } from '@renderer/lib/host-paths'
import { i18n } from '@renderer/lib/i18n'

/** Whether the dialog shows sessions matching the target project folder or every folder. */
export type ImportScope = 'project' | 'all'

/** One agent's sessions for a scope, as far as its pages have come. */
export interface AgentList {
  sessions: ImportableSession[]
  nextCursor: string | null
  loading: boolean
  error: string | null
}

export type AgentLists = Partial<Record<AgentId, AgentList>>

export interface ScopedAgentLists {
  project: AgentLists
  all: AgentLists
}

export function emptyScopedLists(): ScopedAgentLists {
  return { project: {}, all: {} }
}

/** A listed session's key in the selection; two agents may use the same session id. */
export function importKey(agentId: AgentId, acpSessionId: string): string {
  return `${agentId}\n${acpSessionId}`
}

/** Whether the list came, so its count is known. */
export function listed(list: AgentList | undefined): list is AgentList {
  return !!list && !list.error && !(list.loading && list.sessions.length === 0)
}

/** Appends a page of sessions without duplicating any `acpSessionId` already shown. */
export function appendSessions(
  existing: readonly ImportableSession[],
  incoming: readonly ImportableSession[],
): ImportableSession[] {
  if (existing.length === 0) return [...incoming]
  const seen = new Set(existing.map((s) => s.acpSessionId))
  const extra = incoming.filter((s) => !seen.has(s.acpSessionId))
  return extra.length === 0 ? [...existing] : [...existing, ...extra]
}

/** Normalizes a folder path for equality checks across separators and trailing slashes. */
function folderKey(value: string): string {
  const trimmed = value.length > 1 ? value.replace(/[\\/]+$/, '') : value
  // Windows drive and UNC paths are case-insensitive.
  if (/^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith('\\\\')) {
    return trimmed.replace(/\//g, '\\').toLowerCase()
  }
  return trimmed
}

/** Whether two folder paths refer to the same directory on the same host. */
export function sameFolder(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  return hostOfPath(a) === hostOfPath(b) && folderKey(hostPath(a)) === folderKey(hostPath(b))
}

/** Shortens POSIX home prefixes for compact display while keeping the path recognizable. */
export function formatImportCwd(cwd: string): string {
  const trimmed = cwd.length > 1 ? cwd.replace(/[\\/]+$/, '') : cwd
  return trimmed.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~')
}

/** Filters listed sessions by title or original working directory (all space-separated terms). */
export function filterImportSessions(
  sessions: readonly ImportableSession[],
  query: string,
): ImportableSession[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return [...sessions]
  return sessions.filter((s) => {
    const haystack = [s.title ?? '', s.cwd ?? '', s.cwd ? formatImportCwd(s.cwd) : '']
      .join('\n')
      .toLowerCase()
    return words.every((word) => haystack.includes(word))
  })
}

/**
 * The keys of the sessions that are not in Kettu yet, in order; one a terminal still has open is
 * left out, since it cannot be attached.
 */
export function importableKeys(agentId: AgentId, sessions: readonly ImportableSession[]): string[] {
  return sessions
    .filter((s) => !s.imported && !s.held)
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

/** What a source's row says of its list: how many sessions can be imported and how many are picked. */
export interface SourceCount {
  /** Not in Kettu and not open elsewhere, among the pages read so far. */
  importable: number
  selected: number
  /** More pages to read, so `importable` is a lower bound. */
  more: boolean
  /** The list came and holds no session at all. */
  empty: boolean
}

/** Count of selected sessions for an agent across both scopes, deduplicated by session id. */
export function selectedCountForAgent(
  agentId: AgentId,
  scoped: ScopedAgentLists,
  selected: ReadonlySet<string>,
): number {
  const seen = new Set<string>()
  for (const scope of ['project', 'all'] as const) {
    for (const s of scoped[scope][agentId]?.sessions ?? []) {
      if (!s.imported && selected.has(importKey(agentId, s.acpSessionId))) {
        seen.add(s.acpSessionId)
      }
    }
  }
  return seen.size
}

/** A source's counts, or null while its list is not known. */
export function sourceCount(
  agentId: AgentId,
  list: AgentList | undefined,
  selected: ReadonlySet<string>,
  selectedOverride?: number,
): SourceCount | null {
  if (!listed(list)) return null
  const keys = importableKeys(agentId, list.sessions)
  const more = list.nextCursor !== null || list.loading
  const picked = selectedOverride ?? keys.filter((key) => selected.has(key)).length
  return {
    importable: Math.max(keys.length, picked),
    selected: picked,
    more,
    empty: list.sessions.length === 0 && !more && picked === 0,
  }
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

/** The selected sessions still to import, in the tabs' order, deduplicated across scopes. */
export function selectedSessions(
  agents: readonly AgentId[],
  scoped: ScopedAgentLists,
  selected: ReadonlySet<string>,
): { agentId: AgentId; acpSessionId: string }[] {
  const out: { agentId: AgentId; acpSessionId: string }[] = []
  const seen = new Set<string>()
  for (const agentId of agents) {
    for (const scope of ['project', 'all'] as const) {
      for (const s of scoped[scope][agentId]?.sessions ?? []) {
        const key = importKey(agentId, s.acpSessionId)
        if (s.imported || !selected.has(key) || seen.has(key)) continue
        seen.add(key)
        out.push({ agentId, acpSessionId: s.acpSessionId })
      }
    }
  }
  return out
}

/** Marks one session as imported across both scopes of `scoped`. */
export function markImported(
  scoped: ScopedAgentLists,
  agentId: AgentId,
  acpSessionId: string,
  importedProjectPath: string,
): ScopedAgentLists {
  const mark = (lists: AgentLists): AgentLists => {
    const list = lists[agentId]
    if (!list) return lists
    return {
      ...lists,
      [agentId]: {
        ...list,
        sessions: list.sessions.map((s) =>
          s.acpSessionId === acpSessionId ? { ...s, imported: true, importedProjectPath } : s,
        ),
      },
    }
  }
  return {
    project: mark(scoped.project),
    all: mark(scoped.all),
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
