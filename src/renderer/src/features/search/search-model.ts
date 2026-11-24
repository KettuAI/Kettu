// What Search can find and how a query narrows it: entries, matching, groups and limits.

import { fold, foldText, queryWords } from '@shared/search-fold'
import type { PluginViewIcon } from '@shared/plugin-views'
import type { AgentId } from '@shared/thread'
import type { ArtifactKind } from '@renderer/features/artifacts/model'
import type { SettingsSection } from '@renderer/stores/view'

export type SearchKind =
  | 'session'
  | 'conversation'
  | 'artifact'
  | 'routine'
  | 'project'
  | 'section'
  | 'action'
  | 'pluginAction'

export type SearchAction =
  | 'newSession'
  | 'openProject'
  | 'openOverview'
  | 'openUsage'
  | 'openArtifacts'
  | 'openRoutines'
  | 'openMarketplace'
  | 'openSettings'
  | 'showShortcuts'
  | 'toggleSidebar'
  | 'starKettu'

export const SEARCH_ACTIONS: readonly SearchAction[] = [
  'newSession',
  'openProject',
  'openOverview',
  'openUsage',
  'openArtifacts',
  'openRoutines',
  'openMarketplace',
  'openSettings',
  'showShortcuts',
  'toggleSidebar',
  'starKettu',
]

export type SearchScope =
  'all' | 'sessions' | 'conversations' | 'artifacts' | 'routines' | 'projects' | 'settings'

export const SCOPES: readonly SearchScope[] = [
  'all',
  'sessions',
  'conversations',
  'artifacts',
  'routines',
  'projects',
  'settings',
]

const SCOPE_KIND: Record<Exclude<SearchScope, 'all'>, SearchKind> = {
  sessions: 'session',
  conversations: 'conversation',
  artifacts: 'artifact',
  routines: 'routine',
  projects: 'project',
  settings: 'section',
}

/** The order of the groups while All shows matches. */
const GROUP_ORDER: readonly SearchKind[] = [
  'session',
  'conversation',
  'artifact',
  'routine',
  'project',
  'action',
  'pluginAction',
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
    | {
        /** A session found by what was said in it; the host matched it, not the haystack. */
        kind: 'conversation'
        sessionId: string
        projectPath: string
        agentId: AgentId
        hostId: string | null
        entryId: string
        pos: number
        snippet: string
      }
    | { kind: 'artifact'; artifactId: string; artifactKind: ArtifactKind }
    | { kind: 'routine'; routineId: string }
    | { kind: 'project'; path: string }
    | { kind: 'section'; section: SettingsSection }
    | { kind: 'action'; action: SearchAction; shortcut: string | null }
    | {
        /** An action a plugin declares, which its script runs on the host that has it. */
        kind: 'pluginAction'
        hostId: string | null
        pluginId: string
        actionId: string
        icon: PluginViewIcon | null
        plugin: SearchPlugin
      }
  )

/** The plugin a group of its actions is named for. */
export interface SearchPlugin {
  /** The package's name, which picks its tile's color when it has no icon. */
  name: string
  title: string
  icon: string | null
}

/** A plugin's group is keyed by its host and its id: one plugin can be on several hosts. */
export type GroupKey = SearchKind | 'recent' | `plugin:${string}`

export interface ResultGroup {
  key: GroupKey
  items: SearchEntry[]
  /** Every match of the group, past the rows shown. */
  total: number
  /** The plugin whose actions the group lists, which names it. */
  plugin?: SearchPlugin
}

/**
 * A group of one kind, or for plugin actions a group for each plugin that has some; a plugin's
 * group in `expanded` lists all its matches.
 */
function groupsOf(
  kind: SearchKind,
  found: readonly SearchEntry[],
  limit: number,
  expanded: ReadonlySet<string>,
): ResultGroup[] {
  if (found.length === 0) return []
  if (kind !== 'pluginAction') {
    return [{ key: kind, items: found.slice(0, limit), total: found.length }]
  }
  const byPlugin = new Map<GroupKey, SearchEntry[]>()
  for (const entry of found) {
    if (entry.kind !== 'pluginAction') continue
    const key: GroupKey = `plugin:${entry.hostId ?? ''}/${entry.pluginId}`
    byPlugin.set(key, [...(byPlugin.get(key) ?? []), entry])
  }
  return [...byPlugin].map(([key, items]) => ({
    key,
    items: expanded.has(key) ? items : items.slice(0, limit),
    total: items.length,
    ...(items[0]?.kind === 'pluginAction' && { plugin: items[0].plugin }),
  }))
}

export interface SearchResults {
  groups: ResultGroup[]
  /** Matches per scope; All counts every kind, actions included. */
  counts: Record<SearchScope, number>
  /** The folded words of the query, for marking. */
  words: string[]
}

const NO_GROUPS: ReadonlySet<string> = new Set()

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
 * What Search shows for a query in a scope. Every word must match, ignoring case and accents,
 * except for conversations, which the host has matched already. Matches come most recent first. An empty query lists Recent and the actions in All, and the
 * latest few of a scope; All groups a query's matches by kind, a few each, and a scope lists more.
 */
export function runSearch(
  entries: readonly SearchEntry[],
  query: string,
  scope: SearchScope,
  expanded: ReadonlySet<string> = NO_GROUPS,
): SearchResults {
  const words = queryWords(query)
  const found =
    words.length === 0
      ? entries
      : entries.filter(
          (entry) =>
            entry.kind === 'conversation' || words.every((word) => entry.haystack.includes(word)),
        )

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
    conversations: byKind.get('conversation')?.length ?? 0,
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
    groups.push(
      ...groupsOf('pluginAction', byKind.get('pluginAction') ?? [], ALL_GROUP_LIMIT, expanded),
    )
  } else {
    for (const kind of GROUP_ORDER) {
      groups.push(...groupsOf(kind, byKind.get(kind) ?? [], ALL_GROUP_LIMIT, expanded))
    }
  }
  return { groups, counts, words }
}
