import { create } from 'zustand'
import type { Project, SessionSummary } from '@shared/agent-host'
import { host } from '@renderer/lib/host'
import { i18n } from '@renderer/lib/i18n'
import { NO_PROJECT_GROUP, PINNED_GROUP, type MainView } from './view'

interface SessionsStore {
  byId: Record<string, SessionSummary>
  loaded: boolean
  setAll(summaries: SessionSummary[]): void
  upsert(summary: SessionSummary): void
  remove(sessionId: string): void
  refresh(): Promise<void>
}

export const useSessionsStore = create<SessionsStore>()((set) => ({
  byId: {},
  loaded: false,
  setAll(summaries) {
    set({ byId: Object.fromEntries(summaries.map((s) => [s.id, s])), loaded: true })
  },
  upsert(summary) {
    set((state) => ({ byId: { ...state.byId, [summary.id]: summary } }))
  },
  remove(sessionId) {
    set((state) => {
      if (!(sessionId in state.byId)) return state
      const byId = { ...state.byId }
      delete byId[sessionId]
      return { byId }
    })
  },
  async refresh() {
    const summaries = await host('sessions.list', {})
    useSessionsStore.getState().setAll(summaries)
  },
}))

/** Whether a folder is the scratch folder of a session started with No project. */
export function isScratchFolder(byId: Record<string, SessionSummary>, path: string): boolean {
  return Object.values(byId).some((s) => s.scratch && s.projectPath === path)
}

export interface SessionNode {
  summary: SessionSummary
  children: SessionNode[]
  /** Pending permission requests here and in every descendant. */
  permissionCount: number
  /** Whether this session or a descendant is running. */
  running: boolean
}

/**
 * The project's sessions as a tree, newest first, with attention summed up from descendants;
 * null for the sessions started with No project, across their scratch folders. Pinned and archived
 * sessions are listed elsewhere, with their sub-sessions.
 */
export function sessionTree(
  byId: Record<string, SessionSummary>,
  projectPath: string | null,
): SessionNode[] {
  return buildTree(
    byId,
    (s) => (projectPath === null ? s.scratch : s.projectPath === projectPath),
    (s) => !s.pinnedAt && !s.archivedAt,
  ).sort((a, b) => b.summary.updatedAt - a.summary.updatedAt)
}

/** The pinned sessions across the projects as trees, in the order they were pinned. */
export function pinnedTree(byId: Record<string, SessionSummary>): SessionNode[] {
  return buildTree(
    byId,
    () => true,
    (s) => !!s.pinnedAt && !s.archivedAt,
  ).sort((a, b) => (a.summary.pinnedAt ?? 0) - (b.summary.pinnedAt ?? 0))
}

/** Whether the session is a pinned top-level session not archived, or one of its sub-sessions. */
export function inPinnedTree(byId: Record<string, SessionSummary>, s: SessionSummary): boolean {
  let root = s
  while (root.parentId && byId[root.parentId]) root = byId[root.parentId]!
  return !!root.pinnedAt && !root.archivedAt
}

/** The archived top-level sessions, the most recently archived first. */
export function archivedSessions(byId: Record<string, SessionSummary>): SessionSummary[] {
  return Object.values(byId)
    .filter((s) => s.parentId === null && !!s.archivedAt)
    .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0))
}

function buildTree(
  byId: Record<string, SessionSummary>,
  within: (s: SessionSummary) => boolean,
  rootKept: (s: SessionSummary) => boolean,
): SessionNode[] {
  const children = new Map<string, SessionSummary[]>()
  const roots: SessionSummary[] = []
  for (const s of Object.values(byId)) {
    if (!within(s) || s.archivedAt) continue
    if (s.parentId && byId[s.parentId]) {
      const list = children.get(s.parentId) ?? []
      list.push(s)
      children.set(s.parentId, list)
    } else if (rootKept(s)) {
      roots.push(s)
    }
  }
  const build = (summary: SessionSummary): SessionNode => {
    const kids = (children.get(summary.id) ?? [])
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(build)
    return {
      summary,
      children: kids,
      permissionCount: summary.permissionCount + kids.reduce((n, k) => n + k.permissionCount, 0),
      running: isActive(summary) || kids.some((k) => k.running),
    }
  }
  return roots.map(build)
}

function isActive(summary: SessionSummary): boolean {
  return summary.status === 'running' || summary.status === 'awaiting_permission'
}

/** The sessions in sidebar order, flattened, for Mod+Shift+[ and ]. */
export function flattenTree(nodes: SessionNode[], expanded: (id: string) => boolean): string[] {
  const out: string[] = []
  const walk = (list: SessionNode[]) => {
    for (const node of list) {
      out.push(node.summary.id)
      if (node.children.length && expanded(node.summary.id)) walk(node.children)
    }
  }
  walk(nodes)
  return out
}

/** What the sidebar's list reads from the view store. */
export interface SidebarView {
  main: MainView
  collapsedProjects: Record<string, true>
  expandedParents: Record<string, boolean>
}

/** The list's one Tab stop: a session's row, or a group's header by its key. */
export type SidebarTabStop = { kind: 'session'; id: string } | { kind: 'group'; key: string }

/**
 * The sessions the sidebar lists, in its order: Pinned, then each project's, then No project's.
 * A collapsed group or parent leaves out the rows it hides.
 */
export function visibleOrder(
  view: SidebarView,
  byId: Record<string, SessionSummary>,
  projects: readonly Project[],
): string[] {
  const expanded = (id: string) => view.expandedParents[id] ?? false
  return [
    ...(view.collapsedProjects[PINNED_GROUP] ? [] : flattenTree(pinnedTree(byId), expanded)),
    ...projects
      .filter((p) => !view.collapsedProjects[p.path])
      .flatMap((p) => flattenTree(sessionTree(byId, p.path), expanded)),
    ...(view.collapsedProjects[NO_PROJECT_GROUP]
      ? []
      : flattenTree(sessionTree(byId, null), expanded)),
  ]
}

/**
 * The list's one Tab stop: the shown session's row while the list shows it, otherwise the first
 * group header, then no stop at all while the list has no rows.
 */
export function sidebarTabStop(
  view: SidebarView,
  byId: Record<string, SessionSummary>,
  projects: readonly Project[],
): SidebarTabStop | null {
  const order = visibleOrder(view, byId, projects)
  if (view.main.kind === 'session' && order.includes(view.main.sessionId)) {
    return { kind: 'session', id: view.main.sessionId }
  }
  if (pinnedTree(byId).length > 0) return { kind: 'group', key: PINNED_GROUP }
  const project = projects.find((p) => sessionTree(byId, p.path).length > 0)
  if (project) return { kind: 'group', key: project.path }
  if (sessionTree(byId, null).length > 0) return { kind: 'group', key: NO_PROJECT_GROUP }
  return null
}

export function sessionTitle(summary: Pick<SessionSummary, 'title'>): string {
  return summary.title?.trim() || i18n.t('app:newSession')
}
