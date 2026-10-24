// The Artifacts page's list: the filter, then the groups and their order. See
// docs/design/artifacts.md#artifacts-page.

import type { ArtifactSummary } from '@shared/artifacts'
import { basename } from '@renderer/lib/format'

export type ArtifactGrouping = 'project-session' | 'project' | 'date' | 'none'
export type ArtifactSort = 'newest' | 'oldest' | 'name' | 'name-desc'

export const GROUPINGS: readonly ArtifactGrouping[] = ['project-session', 'project', 'date', 'none']
export const SORTS: readonly ArtifactSort[] = ['newest', 'oldest', 'name', 'name-desc']

export type DateBucket = 'today' | 'yesterday' | 'week' | 'month' | 'older'

const DATE_BUCKETS: readonly DateBucket[] = ['today', 'yesterday', 'week', 'month', 'older']

/** What a group stands for; the page names it. */
export type GroupKind =
  | { kind: 'project'; path: string; name: string }
  | { kind: 'no-project' }
  | { kind: 'date'; bucket: DateBucket }
  | { kind: 'all' }

/** A session's cards under its row, or a grid without a row. */
export interface Section {
  key: string
  /** The session whose row heads the section, under Project and session only. */
  sessionId: string | null
  artifacts: ArtifactSummary[]
}

export interface Group {
  key: string
  of: GroupKind
  count: number
  sections: Section[]
}

export interface ListContext {
  /** The sidebar's projects, in its order. */
  projects: readonly { path: string; name: string }[]
  /** A session's title and last update, or null for one no longer in the index. */
  session(id: string): { title: string; updatedAt: number } | null
  /** What a session no longer in the index is called. */
  deletedSession: string
  /** Names in the interface language, with numbers in numeric order. */
  collator: Intl.Collator
  now: number
}

/** Folded for matching: no case, no accents. */
export function foldForMatch(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase()
}

/** The artifacts whose title holds the filter's text; a blank filter keeps them all. */
export function filterByTitle(list: readonly ArtifactSummary[], filter: string): ArtifactSummary[] {
  const wanted = foldForMatch(filter.trim())
  if (!wanted) return [...list]
  return list.filter((artifact) => foldForMatch(artifact.title).includes(wanted))
}

const DAY = 24 * 60 * 60 * 1000

/** How long before `now` a time falls, in local calendar days. */
function daysBefore(at: number, now: number): number {
  const start = (t: number): number => new Date(t).setHours(0, 0, 0, 0)
  // Rounded, since a day across a DST change is not 24 hours.
  return Math.round((start(now) - start(at)) / DAY)
}

export function dateBucket(at: number, now: number): DateBucket {
  const days = daysBefore(at, now)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days <= 7) return 'week'
  if (days <= 30) return 'month'
  return 'older'
}

function byTime(sort: ArtifactSort) {
  return (a: number, b: number): number => (sort === 'oldest' ? a - b : b - a)
}

/** The page's groups, from artifacts already filtered. */
export function groupArtifacts(
  list: readonly ArtifactSummary[],
  grouping: ArtifactGrouping,
  sort: ArtifactSort,
  context: ListContext,
): Group[] {
  const named = sort === 'name' || sort === 'name-desc'
  const sign = sort === 'name-desc' ? -1 : 1
  const time = byTime(sort)
  const cards = [...list].sort((a, b) =>
    named
      ? sign * context.collator.compare(a.title, b.title) || b.updatedAt - a.updatedAt
      : time(a.updatedAt, b.updatedAt) || a.id.localeCompare(b.id),
  )

  if (grouping === 'none') {
    return cards.length
      ? [
          {
            key: 'all',
            of: { kind: 'all' },
            count: cards.length,
            sections: [section('all', cards)],
          },
        ]
      : []
  }

  if (grouping === 'date') {
    const buckets = named || sort === 'newest' ? DATE_BUCKETS : [...DATE_BUCKETS].reverse()
    return buckets.flatMap((bucket) => {
      const mine = cards.filter((a) => dateBucket(a.updatedAt, context.now) === bucket)
      return mine.length
        ? [
            {
              key: bucket,
              of: { kind: 'date', bucket },
              count: mine.length,
              sections: [section(bucket, mine)],
            },
          ]
        : []
    })
  }

  return projectGroups(cards, context).map(({ key, of, artifacts }) => ({
    key,
    of,
    count: artifacts.length,
    sections:
      grouping === 'project'
        ? [section(key, artifacts)]
        : sessionSections(artifacts, sort, context).map((s) => ({ ...s, key: `${key}\n${s.key}` })),
  }))
}

function section(key: string, artifacts: ArtifactSummary[]): Section {
  return { key, sessionId: null, artifacts }
}

/**
 * Projects in the sidebar's order, then folders no longer in the sidebar by name, then No project;
 * the sort never moves them.
 */
function projectGroups(
  cards: readonly ArtifactSummary[],
  context: ListContext,
): { key: string; of: GroupKind; artifacts: ArtifactSummary[] }[] {
  const byFolder = new Map<string, ArtifactSummary[]>()
  const scratch: ArtifactSummary[] = []
  for (const artifact of cards) {
    if (artifact.scratch) {
      scratch.push(artifact)
      continue
    }
    const mine = byFolder.get(artifact.project)
    if (mine) mine.push(artifact)
    else byFolder.set(artifact.project, [artifact])
  }
  const groups: { key: string; of: GroupKind; artifacts: ArtifactSummary[] }[] = []
  for (const project of context.projects) {
    const mine = byFolder.get(project.path)
    if (!mine) continue
    byFolder.delete(project.path)
    groups.push({ key: project.path, of: { kind: 'project', ...project }, artifacts: mine })
  }
  const removed = [...byFolder].map(([path, artifacts]) => ({
    key: path,
    of: { kind: 'project', path, name: basename(path) } as const,
    artifacts,
  }))
  removed.sort((a, b) => context.collator.compare(a.of.name, b.of.name))
  groups.push(...removed)
  if (scratch.length)
    groups.push({ key: 'no-project', of: { kind: 'no-project' }, artifacts: scratch })
  return groups
}

/** A project's sessions, each heading its cards, in the chosen order. */
function sessionSections(
  cards: readonly ArtifactSummary[],
  sort: ArtifactSort,
  context: ListContext,
): Section[] {
  const bySession = new Map<string, ArtifactSummary[]>()
  for (const artifact of cards) {
    const mine = bySession.get(artifact.sessionId)
    if (mine) mine.push(artifact)
    else bySession.set(artifact.sessionId, [artifact])
  }
  const rows = [...bySession].map(([sessionId, artifacts]) => {
    const session = context.session(sessionId)
    return {
      sessionId,
      artifacts,
      title: session?.title ?? context.deletedSession,
      // A deleted session last changed with its newest artifact.
      updatedAt: session?.updatedAt ?? Math.max(...artifacts.map((a) => a.updatedAt)),
    }
  })
  const named = sort === 'name' || sort === 'name-desc'
  const sign = sort === 'name-desc' ? -1 : 1
  const time = byTime(sort)
  rows.sort((a, b) =>
    named
      ? sign * context.collator.compare(a.title, b.title) || b.updatedAt - a.updatedAt
      : time(a.updatedAt, b.updatedAt) || a.sessionId.localeCompare(b.sessionId),
  )
  return rows.map((row) => ({
    key: row.sessionId,
    sessionId: row.sessionId,
    artifacts: row.artifacts,
  }))
}

/** How many sessions the artifacts come from. */
export function sessionCount(list: readonly ArtifactSummary[]): number {
  return new Set(list.map((artifact) => artifact.sessionId)).size
}
