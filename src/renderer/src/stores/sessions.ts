import { create } from 'zustand'
import type { SessionSummary } from '@shared/agent-host'
import { host } from '@renderer/lib/host'
import { i18n } from '@renderer/lib/i18n'

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
    if (!within(s)) continue
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

export function sessionTitle(summary: Pick<SessionSummary, 'title'>): string {
  return summary.title?.trim() || i18n.t('app:newSession')
}
