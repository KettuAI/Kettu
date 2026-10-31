// The Artifacts page's list: the filters, then the groups and their order.

import {
  ARTIFACT_KEEP_DELETED_MS,
  NO_SESSION,
  type ArtifactSession,
  type ArtifactSummary,
} from '@shared/artifacts'
import { basename } from '@renderer/lib/format'

export type ArtifactGrouping = 'none' | 'project-session'
export type ArtifactSort = 'recent' | 'updated' | 'name'

export const GROUPINGS: readonly ArtifactGrouping[] = ['none', 'project-session']
export const SORTS: readonly ArtifactSort[] = ['recent', 'updated', 'name']

/** The kinds Kettu makes; documents, slides and spreadsheets join when it makes them. */
export type ArtifactKind = 'web' | 'canvas'

export const ARTIFACT_KINDS: readonly ArtifactKind[] = ['web', 'canvas']

export function artifactKind(artifact: ArtifactSummary): ArtifactKind {
  return artifact.pages >= 2 ? 'canvas' : 'web'
}

/** When this device last showed each artifact, by id. */
export type OpenedTimes = Readonly<Record<string, number>>

/** The later of when this device last showed it and when its latest version was made. */
export function recency(artifact: ArtifactSummary, opened: OpenedTimes): number {
  return Math.max(opened[artifact.id] ?? 0, artifact.updatedAt)
}

/** Opened times as stored, keeping only well-formed entries. */
export function parseOpened(value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === 'number' && Number.isFinite(entry[1]),
    ),
  )
}

/**
 * The times with `id` shown at `at`; once the lists are known (`known`), only artifacts still on
 * this computer keep theirs.
 */
export function withOpened(
  opened: OpenedTimes,
  id: string,
  at: number,
  known: ReadonlySet<string> | null,
): Record<string, number> {
  const next: Record<string, number> = { [id]: at }
  for (const [other, time] of Object.entries(opened)) {
    if (other !== id && (!known || known.has(other))) next[other] = time
  }
  return next
}

/** What the project filter picks for the artifacts under No project; a folder is never empty. */
export const NO_PROJECT = ''

export interface ListFilter {
  /** Text the title holds; blank keeps every title. */
  title: string
  kind: ArtifactKind | null
  /** A project's folder, or NO_PROJECT; null keeps every project. */
  project: string | null
}

/** A group's heading; the page names it. */
export type GroupKind =
  { kind: 'project'; path: string; name: string } | { kind: 'no-project' } | { kind: 'all' }

/** A session's cards under its row, or a grid without a row. */
export interface Section {
  key: string
  /** The session whose row heads the section, when grouped only. */
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
  /** What the artifacts the user imported show under, in place of a session. */
  imported: string
  /** Names in the interface language, with numbers in numeric order. */
  collator: Intl.Collator
  opened: OpenedTimes
}

/** Folded for matching: no case, no accents. */
export function foldForMatch(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase()
}

/** The artifacts the filter keeps: the title holds its text, of its kind, in its project. */
export function filterArtifacts(
  list: readonly ArtifactSummary[],
  { title, kind, project }: ListFilter,
): ArtifactSummary[] {
  const wanted = foldForMatch(title.trim())
  return list.filter(
    (artifact) =>
      (!wanted || foldForMatch(artifact.title).includes(wanted)) &&
      (!kind || artifactKind(artifact) === kind) &&
      (project === null ||
        (project === NO_PROJECT
          ? artifact.scratch
          : !artifact.scratch && artifact.project === project)),
  )
}

/** The projects the artifacts are in, in the grouping's order, for the project filter. */
export function projectsOf(
  list: readonly ArtifactSummary[],
  context: Pick<ListContext, 'projects' | 'collator'>,
): GroupKind[] {
  return projectGroups(list, context).map((group) => group.of)
}

/** The page's groups, from artifacts already filtered. */
export function groupArtifacts(
  list: readonly ArtifactSummary[],
  grouping: ArtifactGrouping,
  sort: ArtifactSort,
  context: ListContext,
): Group[] {
  const time = (artifact: ArtifactSummary): number =>
    sort === 'updated' ? artifact.updatedAt : recency(artifact, context.opened)
  const cards = [...list].sort((a, b) =>
    sort === 'name'
      ? context.collator.compare(a.title, b.title) || time(b) - time(a)
      : time(b) - time(a) || a.id.localeCompare(b.id),
  )

  if (grouping === 'none') {
    return cards.length
      ? [
          {
            key: 'all',
            of: { kind: 'all' },
            count: cards.length,
            sections: [{ key: 'all', sessionId: null, artifacts: cards }],
          },
        ]
      : []
  }

  return projectGroups(cards, context).map(({ key, of, artifacts }) => ({
    key,
    of,
    count: artifacts.length,
    sections: sessionSections(artifacts, sort, time, context).map((s) => ({
      ...s,
      key: `${key}\n${s.key}`,
    })),
  }))
}

/**
 * Projects in the sidebar's order, then folders no longer in the sidebar by name, then No project;
 * the sort never moves them.
 */
function projectGroups(
  cards: readonly ArtifactSummary[],
  context: Pick<ListContext, 'projects' | 'collator'>,
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

/**
 * A project's sessions, each heading its cards: by title, by the session's last update, or by the
 * most recent of its cards.
 */
function sessionSections(
  cards: readonly ArtifactSummary[],
  sort: ArtifactSort,
  time: (artifact: ArtifactSummary) => number,
  context: ListContext,
): Section[] {
  const bySession = new Map<string, ArtifactSummary[]>()
  for (const artifact of cards) {
    const mine = bySession.get(artifact.sessionId)
    if (mine) mine.push(artifact)
    else bySession.set(artifact.sessionId, [artifact])
  }
  const rows = [...bySession].map(([sessionId, artifacts]) => {
    const session = sessionId === NO_SESSION ? null : context.session(sessionId)
    const newest = Math.max(...artifacts.map(time))
    return {
      sessionId,
      artifacts,
      title:
        session?.title ?? (sessionId === NO_SESSION ? context.imported : context.deletedSession),
      // A deleted session, and the imports, last changed with their newest artifact.
      time: sort === 'updated' ? (session?.updatedAt ?? newest) : newest,
    }
  })
  rows.sort((a, b) =>
    sort === 'name'
      ? context.collator.compare(a.title, b.title) || b.time - a.time
      : b.time - a.time || a.sessionId.localeCompare(b.sessionId),
  )
  return rows.map((row) => ({
    key: row.sessionId,
    sessionId: row.sessionId,
    artifacts: row.artifacts,
  }))
}

/** New session's draft with the line that asks for a kind: after a blank line when it has text. */
export function withAskLine(draft: string, line: string): string {
  const written = draft.replace(/\s+$/, '')
  return written ? `${written}\n\n${line}` : line
}

/** How many sessions the artifact's top shows as avatars before it counts the rest. */
const PRESENCE_SHOWN = 3

export interface PresenceShown {
  all: ArtifactSession[]
  shown: ArtifactSession[]
  more: number
}

/**
 * Who shows at an artifact's top: the editing sessions first, then the reading ones, each in the
 * order it started; three at most, or two and the count of the rest from four.
 */
export function presenceShown(sessions: readonly ArtifactSession[]): PresenceShown {
  const all = [
    ...sessions.filter((session) => session.editing),
    ...sessions.filter((session) => !session.editing),
  ]
  if (all.length <= PRESENCE_SHOWN) return { all, shown: all, more: 0 }
  const shown = all.slice(0, PRESENCE_SHOWN - 1)
  return { all, shown, more: all.length - shown.length }
}

const DAY = 24 * 60 * 60 * 1000

/** Whole days before Recently deleted removes an artifact for good: 30 on the day it went. */
export function daysLeft(deletedAt: number, now: number): number {
  // `now` ticks every 30 s, so a deletion just made can be newer than it.
  const since = Math.max(0, now - deletedAt)
  return Math.max(1, Math.ceil((ARTIFACT_KEEP_DELETED_MS - since) / DAY))
}
