// What Search can find and how a query narrows it: entries, matching, groups and limits.

import type { AgentId } from '@shared/thread'
import type { ArtifactKind } from '@renderer/features/artifacts/model'
import type { SettingsSection } from '@renderer/stores/view'

export type SearchKind = 'session' | 'artifact' | 'routine' | 'project' | 'section' | 'action'

export type SearchAction =
  | 'newSession'
  | 'openProject'
  | 'openUsage'
  | 'openArtifacts'
  | 'openRoutines'
  | 'openSettings'
  | 'showShortcuts'
  | 'toggleSidebar'

export const SEARCH_ACTIONS: readonly SearchAction[] = [
  'newSession',
  'openProject',
  'openUsage',
  'openArtifacts',
  'openRoutines',
  'openSettings',
  'showShortcuts',
  'toggleSidebar',
]

export type SearchScope = 'all' | 'sessions' | 'artifacts' | 'routines' | 'projects' | 'settings'

export const SCOPES: readonly SearchScope[] = [
  'all',
  'sessions',
  'artifacts',
  'routines',
  'projects',
  'settings',
]

const SCOPE_KIND: Record<Exclude<SearchScope, 'all'>, SearchKind> = {
  sessions: 'session',
  artifacts: 'artifact',
  routines: 'routine',
  projects: 'project',
  settings: 'section',
}

/** The order of the groups while All shows matches. */
const GROUP_ORDER: readonly SearchKind[] = [
  'session',
  'artifact',
  'routine',
  'project',
  'action',
  'section',
]

/** The kinds the empty All view lists as Recent; the rest have no recency worth ranking. */
const RECENT_KINDS: ReadonlySet<SearchKind> = new Set(['session', 'artifact', 'routine'])

/** Rows of Recent, the empty All view. */
export const RECENT_LIMIT = 6
/** Rows per group while All shows matches. */
export const ALL_GROUP_LIMIT = 3
/** Rows of a scope while the field is empty, and while it holds a query. */
export const SCOPE_EMPTY_LIMIT = 20
export const SCOPE_LIMIT = 50

interface EntryBase {
  /** Unique across kinds. */
  key: string
  title: string
  /** Right of the title, such as a session's project and branch. */
  meta: string | null
  /** At the row's end, such as how long ago or how many. */
  trailing: string | null
  /** Folded text the query is matched against. */
  haystack: string
  /** Recency for ranking; entries with none keep their given order. */
  at: number
}

export type SearchEntry = EntryBase &
  (
    | {
        kind: 'session'
        sessionId: string
        projectPath: string
        agentId: AgentId
        hostId: string | null
      }
    | { kind: 'artifact'; artifactId: string; artifactKind: ArtifactKind }
    | { kind: 'routine'; routineId: string }
    | { kind: 'project'; path: string }
    | { kind: 'section'; section: SettingsSection }
    | { kind: 'action'; action: SearchAction; shortcut: string | null }
  )

export type GroupKey = SearchKind | 'recent'

export interface ResultGroup {
  key: GroupKey
  items: SearchEntry[]
  /** Every match of the group, past the rows shown. */
  total: number
}

export interface SearchResults {
  groups: ResultGroup[]
  /** Matches per scope; All counts every kind, actions included. */
  counts: Record<SearchScope, number>
  /** The folded words of the query, for marking. */
  words: string[]
}

interface Folded {
  text: string
  /** For each character of `text`, where it starts in the original; one more for the end. */
  from: number[]
}

function foldChar(char: string): string {
  return char.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase()
}

/** The text without case and accents, remembering where each character came from. */
function fold(text: string): Folded {
  let folded = ''
  const from: number[] = []
  let at = 0
  for (const char of text) {
    const next = foldChar(char)
    for (let i = 0; i < next.length; i++) from.push(at)
    folded += next
    at += char.length
  }
  from.push(at)
  return { text: folded, from }
}

/** The text as matching reads it: no case, no accents. */
export function foldText(text: string): string {
  return fold(text).text
}

/** The words of a query, folded. */
export function queryWords(query: string): string[] {
  return foldText(query).split(/\s+/).filter(Boolean)
}

/** The text that matching reads for an entry: its title, meta and anything else it is found by. */
export function haystackOf(...parts: readonly (string | null | undefined)[]): string {
  return foldText(parts.filter(Boolean).join('\n'))
}

/** The text cut around the words, each run flagged as a match or not. */
export function markParts(
  text: string,
  words: readonly string[],
): { text: string; match: boolean }[] {
  if (words.length === 0) return [{ text, match: false }]
  const folded = fold(text)
  const marked = new Array<boolean>(text.length).fill(false)
  for (const word of words) {
    for (let at = folded.text.indexOf(word); at >= 0; at = folded.text.indexOf(word, at + 1)) {
      marked.fill(true, folded.from[at]!, folded.from[at + word.length]!)
    }
  }
  const parts: { text: string; match: boolean }[] = []
  for (let i = 0; i < text.length; i++) {
    const last = parts.at(-1)
    if (last && last.match === marked[i]) last.text += text[i]
    else parts.push({ text: text[i]!, match: marked[i]! })
  }
  return parts
}

function byRecency(a: SearchEntry, b: SearchEntry): number {
  return b.at - a.at
}

/**
 * What Search shows for a query in a scope. Every word must match, ignoring case and accents.
 * Matches come most recent first. An empty query lists Recent and the actions in All, and the
 * latest few of a scope; All groups a query's matches by kind, a few each, and a scope lists more.
 */
export function runSearch(
  entries: readonly SearchEntry[],
  query: string,
  scope: SearchScope,
): SearchResults {
  const words = queryWords(query)
  const found =
    words.length === 0
      ? entries
      : entries.filter((entry) => words.every((word) => entry.haystack.includes(word)))

  const byKind = new Map<SearchKind, SearchEntry[]>()
  for (const entry of found) {
    const list = byKind.get(entry.kind)
    if (list) list.push(entry)
    else byKind.set(entry.kind, [entry])
  }
  for (const list of byKind.values()) list.sort(byRecency)

  const counts: Record<SearchScope, number> = {
    all: found.length,
    sessions: byKind.get('session')?.length ?? 0,
    artifacts: byKind.get('artifact')?.length ?? 0,
    routines: byKind.get('routine')?.length ?? 0,
    projects: byKind.get('project')?.length ?? 0,
    settings: byKind.get('section')?.length ?? 0,
  }

  const groups: ResultGroup[] = []
  if (scope !== 'all') {
    const kind = SCOPE_KIND[scope]
    const items = byKind.get(kind) ?? []
    if (items.length > 0) {
      const limit = words.length === 0 ? SCOPE_EMPTY_LIMIT : SCOPE_LIMIT
      groups.push({ key: kind, items: items.slice(0, limit), total: items.length })
    }
  } else if (words.length === 0) {
    const recent = found.filter((entry) => RECENT_KINDS.has(entry.kind)).sort(byRecency)
    if (recent.length > 0) {
      const items = recent.slice(0, RECENT_LIMIT)
      groups.push({ key: 'recent', items, total: items.length })
    }
    const actions = byKind.get('action') ?? []
    if (actions.length > 0) groups.push({ key: 'action', items: actions, total: actions.length })
  } else {
    for (const kind of GROUP_ORDER) {
      const items = byKind.get(kind)
      if (items)
        groups.push({ key: kind, items: items.slice(0, ALL_GROUP_LIMIT), total: items.length })
    }
  }
  return { groups, counts, words }
}
