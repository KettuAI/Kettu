import type { Project, ProjectIcon, SessionSummary } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import { basename, clockTime, mediumAgo } from '@renderer/lib/format'
import { hostPath } from '@renderer/lib/host-paths'
import { currentLocale } from '@renderer/lib/i18n'
import { readJson, writeJson } from '@renderer/lib/storage'
import { agentName } from '@renderer/stores/agents'
import { archivedProjects, findProjectForSession, projectFolders } from '@renderer/stores/projects'
import {
  listedOrigin,
  projectGroupSummaries,
  sessionArchived,
  sessionTitle,
} from '@renderer/stores/sessions'

export type ArchivedGroupBy = 'date' | 'project'

export const NO_PROJECT_KEY = '__no_project__'
const GROUP_BY_KEY = 'archived-sessions-group-by'

export type ArchivedDateBucket =
  | { kind: 'today' }
  | { kind: 'yesterday' }
  | { kind: 'earlierThisWeek' }
  | { kind: 'earlierThisMonth' }
  | { kind: 'month'; year: number; month: number; currentYear: boolean }

export interface ArchivedEntry {
  summary: SessionSummary
  title: string
  projectKey: string
  projectLabel: string
  projectIcon?: ProjectIcon
  /** Worktree branch shown on the row when the session has one. */
  branch: string | null
  /** Branch text matched by search (worktree branch or last checked-out branch). */
  searchBranch: string | null
  /** Title of the unarchived parent when this sub-session was archived on its own. */
  parentTitle: string | null
  /** Number of non-subagent sub-sessions archived together under this session. */
  subSessionCount: number
  archivedAt: number
  agentId: AgentId
  agentLabel: string
}

export interface FacetOption {
  id: string
  label: string
  count: number
  /** True for the synthetic No project entry so it sorts after real projects when tied. */
  scratch?: boolean
  icon?: ProjectIcon
}

export interface ArchivedGroup {
  id: string
  kind: 'date' | 'project'
  bucket?: ArchivedDateBucket
  projectKey?: string
  projectLabel?: string
  projectIcon?: ProjectIcon
  scratch?: boolean
  entries: ArchivedEntry[]
}

export interface TextPart {
  text: string
  match: boolean
}

export interface ArchivedProjectSession {
  summary: SessionSummary
  title: string
  branch: string | null
  subSessionCount: number
  /** True when the session itself was archived individually before or after the project. */
  sessionArchived: boolean
  updatedAt: number
  agentId: AgentId
  agentLabel: string
}

export interface ArchivedProjectEntry {
  project: Project
  archivedAt: number
  folders: string[]
  sessions: ArchivedProjectSession[]
}

export function readArchivedGroupBy(): ArchivedGroupBy {
  const saved = readJson<unknown>(GROUP_BY_KEY, 'date')
  return saved === 'project' ? 'project' : 'date'
}

export function saveArchivedGroupBy(value: ArchivedGroupBy): void {
  writeJson(GROUP_BY_KEY, value)
}

/** Counts non-subagent descendant sessions archived with each root session. */
function archivedSubSessionCounts(byId: Record<string, SessionSummary>): Map<string, number> {
  const children = new Map<string, SessionSummary[]>()
  for (const s of Object.values(byId)) {
    if (!s.parentId || !listedOrigin(s)) continue
    let list = children.get(s.parentId)
    if (!list) children.set(s.parentId, (list = []))
    list.push(s)
  }
  const memo = new Map<string, number>()
  const visiting = new Set<string>()
  const countUnder = (id: string): number => {
    const cached = memo.get(id)
    if (cached !== undefined) return cached
    if (visiting.has(id)) return 0
    visiting.add(id)
    let total = 0
    for (const child of children.get(id) ?? []) {
      if (child.prepared) continue
      if (child.origin === 'subagent') {
        total += countUnder(child.id)
      } else {
        total += 1 + countUnder(child.id)
      }
    }
    visiting.delete(id)
    memo.set(id, total)
    return total
  }
  const counts = new Map<string, number>()
  for (const id of children.keys()) {
    const n = countUnder(id)
    if (n > 0) counts.set(id, n)
  }
  return counts
}

/** Builds view entries for archived projects on `hostId`, with each project's retained history. */
export function buildArchivedProjects(
  projects: readonly Project[],
  byId: Record<string, SessionSummary>,
  hostId: string | null,
): ArchivedProjectEntry[] {
  const subCounts = archivedSubSessionCounts(byId)
  return archivedProjects(projects, hostId).map((project) => {
    const own = projectGroupSummaries(byId, project, hostId, projects)
    const ownIds = new Set(own.map((s) => s.id))
    const sessions = own
      .filter(
        (s) =>
          listedOrigin(s) &&
          s.origin !== 'subagent' &&
          !s.prepared &&
          !(s.parentId && ownIds.has(s.parentId)),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((summary): ArchivedProjectSession => ({
        summary,
        title: sessionTitle(summary),
        branch: summary.worktree?.branch ?? null,
        subSessionCount: subCounts.get(summary.id) ?? 0,
        sessionArchived: sessionArchived(byId, summary.id),
        updatedAt: summary.updatedAt,
        agentId: summary.agentId,
        agentLabel: agentName(summary.agentId, hostId),
      }))
    return {
      project,
      archivedAt: project.archivedAt ?? project.lastOpenedAt,
      folders: projectFolders(project),
      sessions,
    }
  })
}

/** Builds view entries for the host's archived sessions (already sorted newest archived first). */
export function buildArchivedEntries(
  archived: readonly SessionSummary[],
  byId: Record<string, SessionSummary>,
  projects: readonly Project[],
  hostId: string | null,
  noProjectLabel: string,
): ArchivedEntry[] {
  const subCounts = archivedSubSessionCounts(byId)
  return archived.map((summary) => {
    const owner = summary.scratch ? undefined : findProjectForSession(projects, summary)
    const projectKey = summary.scratch ? NO_PROJECT_KEY : (owner?.path ?? summary.projectPath)
    const projectLabel = summary.scratch
      ? noProjectLabel
      : (owner?.name ?? basename(hostPath(summary.projectPath)))
    const parent = summary.parentId ? byId[summary.parentId] : undefined
    const worktreeBranch = summary.worktree?.branch ?? null
    return {
      summary,
      title: sessionTitle(summary),
      projectKey,
      projectLabel,
      ...(owner?.icon ? { projectIcon: owner.icon } : {}),
      branch: worktreeBranch,
      searchBranch: worktreeBranch ?? summary.branch ?? null,
      parentTitle: parent ? sessionTitle(parent) : null,
      subSessionCount: subCounts.get(summary.id) ?? 0,
      archivedAt: summary.archivedAt ?? summary.updatedAt,
      agentId: summary.agentId,
      agentLabel: agentName(summary.agentId, hostId),
    }
  })
}

export function queryWords(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean)
}

export function matchesArchivedQuery(entry: ArchivedEntry, words: readonly string[]): boolean {
  if (words.length === 0) return true
  const haystack =
    `${entry.title}\n${entry.projectLabel}\n${entry.searchBranch ?? ''}\n${entry.parentTitle ?? ''}`.toLowerCase()
  return words.every((word) => haystack.includes(word))
}

/** Splits text around case-insensitive occurrences of any search word, merging overlaps. */
export function highlightMatches(text: string, query: string): TextPart[] {
  const words = queryWords(query)
  if (words.length === 0 || text.length === 0) return [{ text, match: false }]
  const lower = text.toLowerCase()
  const marked = new Array<boolean>(text.length).fill(false)
  for (const word of words) {
    let from = 0
    while (from < lower.length) {
      const idx = lower.indexOf(word, from)
      if (idx === -1) break
      marked.fill(true, idx, idx + word.length)
      from = idx + word.length
    }
  }
  const parts: TextPart[] = []
  for (let i = 0; i < text.length; i++) {
    const last = parts.at(-1)
    if (last && last.match === marked[i]) last.text += text[i]
    else parts.push({ text: text[i]!, match: marked[i]! })
  }
  return parts
}

export function projectFacets(
  entries: readonly ArchivedEntry[],
  words: readonly string[],
  agentFilter: AgentId | null,
): { total: number; options: FacetOption[] } {
  const counts = new Map<string, FacetOption>()
  let total = 0
  for (const entry of entries) {
    if (agentFilter && entry.agentId !== agentFilter) continue
    if (!matchesArchivedQuery(entry, words)) continue
    total += 1
    const existing = counts.get(entry.projectKey)
    if (existing) existing.count += 1
    else {
      counts.set(entry.projectKey, {
        id: entry.projectKey,
        label: entry.projectLabel,
        count: 1,
        scratch: entry.summary.scratch,
        ...(entry.projectIcon ? { icon: entry.projectIcon } : {}),
      })
    }
  }
  const options = [...counts.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count
    if (!!a.scratch !== !!b.scratch) return a.scratch ? 1 : -1
    return a.label.localeCompare(b.label)
  })
  return { total, options }
}

export function agentFacets(
  entries: readonly ArchivedEntry[],
  words: readonly string[],
  projectFilter: string | null,
): { total: number; options: (FacetOption & { agentId: AgentId })[] } {
  const counts = new Map<AgentId, FacetOption & { agentId: AgentId }>()
  let total = 0
  for (const entry of entries) {
    if (projectFilter && entry.projectKey !== projectFilter) continue
    if (!matchesArchivedQuery(entry, words)) continue
    total += 1
    const existing = counts.get(entry.agentId)
    if (existing) existing.count += 1
    else {
      counts.set(entry.agentId, {
        id: entry.agentId,
        agentId: entry.agentId,
        label: entry.agentLabel,
        count: 1,
      })
    }
  }
  const options = [...counts.values()].sort(
    (a, b) => b.count - a.count || a.label.localeCompare(b.label),
  )
  return { total, options }
}

export function filterArchivedEntries(
  entries: readonly ArchivedEntry[],
  words: readonly string[],
  projectFilter: string | null,
  agentFilter: AgentId | null,
): ArchivedEntry[] {
  return entries.filter((entry) => {
    if (projectFilter && entry.projectKey !== projectFilter) return false
    if (agentFilter && entry.agentId !== agentFilter) return false
    return matchesArchivedQuery(entry, words)
  })
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Bucket boundaries in the local timezone for grouping by archive date. */
function dateBounds(now: number) {
  const d = new Date(now)
  const startOfToday = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const startOfYesterday = startOfToday - DAY_MS
  // ISO week starting on Monday.
  const dayOfWeek = (d.getDay() + 6) % 7
  const startOfWeek = startOfToday - dayOfWeek * DAY_MS
  const startOfMonth = new Date(d.getFullYear(), d.getMonth(), 1).getTime()
  return {
    nowYear: d.getFullYear(),
    startOfToday,
    startOfYesterday,
    startOfWeek,
    startOfMonth,
  }
}

export function dateBucketFor(at: number, now: number): ArchivedDateBucket {
  const { nowYear, startOfToday, startOfYesterday, startOfWeek, startOfMonth } = dateBounds(now)
  if (at >= startOfToday) return { kind: 'today' }
  if (at >= startOfYesterday) return { kind: 'yesterday' }
  if (at >= startOfWeek) return { kind: 'earlierThisWeek' }
  if (at >= startOfMonth) return { kind: 'earlierThisMonth' }
  const d = new Date(at)
  return {
    kind: 'month',
    year: d.getFullYear(),
    month: d.getMonth(),
    currentYear: d.getFullYear() === nowYear,
  }
}

export function dateBucketId(bucket: ArchivedDateBucket): string {
  if (bucket.kind === 'month')
    return `date:${bucket.year}-${String(bucket.month + 1).padStart(2, '0')}`
  return `date:${bucket.kind}`
}

export function groupArchivedEntries(
  entries: readonly ArchivedEntry[],
  by: ArchivedGroupBy,
  now: number,
): ArchivedGroup[] {
  if (by === 'date') {
    const groups: ArchivedGroup[] = []
    const byId = new Map<string, ArchivedGroup>()
    for (const entry of entries) {
      const bucket = dateBucketFor(entry.archivedAt, now)
      const id = dateBucketId(bucket)
      let group = byId.get(id)
      if (!group) {
        group = { id, kind: 'date', bucket, entries: [] }
        byId.set(id, group)
        groups.push(group)
      }
      group.entries.push(entry)
    }
    return groups
  }
  const byProject = new Map<string, ArchivedGroup>()
  for (const entry of entries) {
    const id = `project:${entry.projectKey}`
    let group = byProject.get(id)
    if (!group) {
      group = {
        id,
        kind: 'project',
        projectKey: entry.projectKey,
        projectLabel: entry.projectLabel,
        ...(entry.projectIcon ? { projectIcon: entry.projectIcon } : {}),
        scratch: entry.summary.scratch,
        entries: [],
      }
      byProject.set(id, group)
    }
    group.entries.push(entry)
  }
  // Entries are already newest-archived-first, so insertion order puts most-recently-archived
  // projects first.
  return [...byProject.values()]
}

const dateFormatters = new Map<
  string,
  {
    monthDay: Intl.DateTimeFormat
    monthOnly: Intl.DateTimeFormat
    monthYear: Intl.DateTimeFormat
  }
>()

function getDateFormatters() {
  const locale = currentLocale()
  let fmt = dateFormatters.get(locale)
  if (!fmt) {
    fmt = {
      monthDay: new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }),
      monthOnly: new Intl.DateTimeFormat(locale, { month: 'long' }),
      monthYear: new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }),
    }
    dateFormatters.set(locale, fmt)
  }
  return fmt
}

export function formatMonthHeading(year: number, month: number, currentYear: boolean): string {
  const sample = new Date(year, month, 15)
  const fmt = getDateFormatters()
  return currentYear ? fmt.monthOnly.format(sample) : fmt.monthYear.format(sample)
}

/** Row timestamp: clock time in Today/Yesterday, short date in older date groups, relative in project mode. */
export function formatArchivedWhen(
  at: number,
  mode: ArchivedGroupBy,
  bucket: ArchivedDateBucket | undefined,
  now: number,
): string {
  if (mode === 'project') return mediumAgo(at, now)
  if (bucket && (bucket.kind === 'today' || bucket.kind === 'yesterday')) return clockTime(at)
  return getDateFormatters().monthDay.format(at)
}
