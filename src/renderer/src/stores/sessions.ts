import { create } from 'zustand'
import type { Project, SessionSummary } from '@shared/agent-host'
import { host } from '@renderer/lib/host'
import { hostOfPath } from '@renderer/lib/host-paths'
import { i18n } from '@renderer/lib/i18n'
import { NO_PROJECT_GROUP, PINNED_GROUP, type MainView } from './view'

interface SessionsStore {
  byId: Record<string, SessionSummary>
  /** Whether this computer's list came; another host's sessions come with its connection. */
  loaded: boolean
  /** Replaces the sessions of one host, null being this computer, and leaves the others'. */
  setAll(summaries: SessionSummary[], hostId?: string | null): void
  upsert(summary: SessionSummary): void
  remove(sessionId: string): void
  refresh(): Promise<void>
}

export const useSessionsStore = create<SessionsStore>()((set) => ({
  byId: {},
  loaded: false,
  setAll(summaries, hostId = null) {
    // The list leaves out a routine's run sessions; one that is open stays for its view, which
    // the host still knows, and its removal comes as a session.removed event.
    const kept = (summary: SessionSummary) =>
      hostOfPath(summary.projectPath) !== hostId ||
      (hostId === null && summary.origin === 'routine')
    set((state) => ({
      byId: {
        ...Object.fromEntries(Object.entries(state.byId).filter(([, summary]) => kept(summary))),
        ...Object.fromEntries(summaries.map((summary) => [summary.id, summary])),
      },
      loaded: hostId === null ? true : state.loaded,
    }))
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
  /**
   * The sub-sessions the user started, one level deep: a sub-session's own sub-sessions list here
   * too, by when they were created.
   */
  children: SessionNode[]
  /** The agent's sub-agents of this session, which its row shows as a badge rather than as rows. */
  subagents: SessionSummary[]
  /** Pending permission requests here, in its sub-agents and in its sub-sessions. */
  permissionCount: number
  /** Whether this session or one of its sub-sessions is running; sub-agents run on its badge. */
  running: boolean
  /** The same two for the row alone, with its sub-agents' requests but not its sub-sessions'. */
  own: { permissionCount: number; running: boolean }
}

/** The host a session is on, null being this computer. */
export function hostOfSession(summary: Pick<SessionSummary, 'projectPath'>): string | null {
  return hostOfPath(summary.projectPath)
}

/**
 * The project's sessions as a tree, newest first, with attention summed up from descendants;
 * null for the sessions started with No project on `hostId`, across their scratch folders. Pinned
 * and archived sessions are listed elsewhere, with their sub-sessions. Routine runs keep their own
 * lists.
 */
export function sessionTree(
  byId: Record<string, SessionSummary>,
  projectPath: string | null,
  hostId: string | null = null,
): SessionNode[] {
  return buildTree(
    byId,
    (s) =>
      s.origin !== 'routine' &&
      (projectPath === null
        ? s.scratch && hostOfSession(s) === hostId
        : s.projectPath === projectPath),
    (s) => !s.pinnedAt && !s.archivedAt,
  ).sort((a, b) => b.summary.updatedAt - a.summary.updatedAt)
}

/** The pinned sessions across the projects as trees, in the order they were pinned. */
export function pinnedTree(byId: Record<string, SessionSummary>): SessionNode[] {
  return buildTree(
    byId,
    (s) => s.origin !== 'routine',
    (s) => !!s.pinnedAt && !s.archivedAt,
  ).sort((a, b) => (a.summary.pinnedAt ?? 0) - (b.summary.pinnedAt ?? 0))
}

/**
 * The sessions on any host that wait for a permission answer, here or in a sub-session, or that
 * failed: the top-level ones, the latest first. They stay listed in their projects as well.
 */
export function needsYouTree(byId: Record<string, SessionSummary>): SessionNode[] {
  return (
    buildTree(
      byId,
      (s) => s.origin !== 'routine',
      (s) => !s.archivedAt,
    )
      .filter((node) => node.permissionCount > 0 || node.summary.attention === 'error')
      // The row stands for the whole tree, so it shows what its sub-sessions wait for as its own.
      .map((node) => ({
        ...node,
        children: [],
        own: { permissionCount: node.permissionCount, running: node.running },
      }))
      .sort((a, b) => b.summary.updatedAt - a.summary.updatedAt)
  )
}

/** Whether the session is a pinned top-level session not archived, or one of its sub-sessions. */
export function inPinnedTree(byId: Record<string, SessionSummary>, s: SessionSummary): boolean {
  let root = s
  while (root.parentId && byId[root.parentId]) root = byId[root.parentId]!
  return !!root.pinnedAt && !root.archivedAt
}

/** Archived itself, or under a session that is. A missing parent is not treated as archived. */
export function sessionArchived(byId: Record<string, SessionSummary>, sessionId: string): boolean {
  const seen = new Set<string>()
  let current: SessionSummary | undefined = byId[sessionId]
  while (current && !seen.has(current.id)) {
    if (current.archivedAt) return true
    seen.add(current.id)
    current = current.parentId ? byId[current.parentId] : undefined
  }
  return false
}

/** A host's archived top-level sessions, this computer's by default, latest archived first. */
export function archivedSessions(
  byId: Record<string, SessionSummary>,
  hostId: string | null = null,
): SessionSummary[] {
  return Object.values(byId)
    .filter(
      (s) =>
        s.origin !== 'routine' &&
        s.parentId === null &&
        !!s.archivedAt &&
        hostOfSession(s) === hostId,
    )
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
    } else if (rootKept(s) && s.origin !== 'subagent') {
      roots.push(s)
    }
  }
  const kids = (id: string) =>
    (children.get(id) ?? []).slice().sort((a, b) => a.createdAt - b.createdAt)
  // A sub-agent's requests wait on the row that shows its badge, its own sub-agents' too; their
  // runs show on the badge, not as the row's.
  const agentWaits = (id: string): number =>
    kids(id).reduce(
      (n, child) =>
        child.origin === 'subagent' ? n + child.permissionCount + agentWaits(child.id) : n,
      0,
    )
  // Sub-sessions at any depth, sub-agents' included, as one level.
  const subSessions = (id: string): SessionSummary[] =>
    kids(id).flatMap((child) =>
      child.origin === 'subagent' ? subSessions(child.id) : [child, ...subSessions(child.id)],
    )
  const row = (summary: SessionSummary, nested: SessionNode[]): SessionNode => {
    const own = {
      permissionCount: summary.permissionCount + agentWaits(summary.id),
      running: isActive(summary),
    }
    return {
      summary,
      children: nested,
      subagents: kids(summary.id).filter((child) => child.origin === 'subagent'),
      permissionCount: own.permissionCount + nested.reduce((n, k) => n + k.permissionCount, 0),
      running: own.running || nested.some((k) => k.running),
      own,
    }
  }
  return roots.map((root) =>
    row(
      root,
      subSessions(root.id)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((child) => row(child, [])),
    ),
  )
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
  /**
   * With other hosts added, the hosts the list shows in its order, null being this computer, and
   * Needs you above them; without, the list is this computer's alone.
   */
  hosts?: readonly (string | null)[] | null
  /** Other hosts not connected now, whose sessions Needs you leaves out: none can be answered. */
  away?: readonly string[]
}

/** The key of a host's No project group; this computer's is `NO_PROJECT_GROUP`. */
export function noProjectGroup(hostId: string | null): string {
  return hostId === null ? NO_PROJECT_GROUP : `${NO_PROJECT_GROUP}:${hostId}`
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
  const hosts = view.hosts ?? [null]
  const shown = (node: SessionNode) => hosts.includes(hostOfSession(node.summary))
  const reachable = (node: SessionNode) => !view.away?.includes(hostOfSession(node.summary) ?? '')
  const order = [
    ...(view.hosts ? needsYouTree(byId).filter((n) => shown(n) && reachable(n)) : []).map(
      (node) => node.summary.id,
    ),
    ...(view.collapsedProjects[PINNED_GROUP]
      ? []
      : flattenTree(pinnedTree(byId).filter(shown), expanded)),
    ...hosts.flatMap((hostId) => [
      ...projects
        .filter((p) => hostOfPath(p.path) === hostId && !view.collapsedProjects[p.path])
        .flatMap((p) => flattenTree(sessionTree(byId, p.path), expanded)),
      ...(view.collapsedProjects[noProjectGroup(hostId)]
        ? []
        : flattenTree(sessionTree(byId, null, hostId), expanded)),
    ]),
  ]
  // A session Needs you lists is listed in its project as well; the keys visit it once.
  return [...new Set(order)]
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
  const hosts = view.hosts ?? [null]
  const shown = (node: SessionNode) => hosts.includes(hostOfSession(node.summary))
  if (pinnedTree(byId).some(shown)) return { kind: 'group', key: PINNED_GROUP }
  for (const hostId of hosts) {
    const project = projects.find(
      (p) => hostOfPath(p.path) === hostId && sessionTree(byId, p.path).length > 0,
    )
    if (project) return { kind: 'group', key: project.path }
    if (sessionTree(byId, null, hostId).length > 0) {
      return { kind: 'group', key: noProjectGroup(hostId) }
    }
  }
  return null
}

export function sessionTitle(summary: Pick<SessionSummary, 'title'>): string {
  return summary.title?.trim() || i18n.t('app:newSession')
}
