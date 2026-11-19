import { create } from 'zustand'
import type { Project, SessionSummary } from '@shared/agent-host'
import type { TaskSummary } from '@shared/workflow'
import { errorMessage, host } from '@renderer/lib/host'
import { hostOfPath } from '@renderer/lib/host-paths'
import { i18n } from '@renderer/lib/i18n'
import { pinnedProjects } from './projects'
import { listedTasks, needingTasks, pinnedTasks, startedSteps, taskExpanded } from './tasks'
import { NO_PROJECT_GROUP, PINNED_GROUP, THIS_COMPUTER, type MainView } from './view'

interface SessionsStore {
  byId: Record<string, SessionSummary>
  /** Whether this computer's list came; another host's sessions come with its connection. */
  loaded: boolean
  /** Why this computer's list could not be read, until it is. */
  error: string | null
  /** Replaces the sessions of one host, null being this computer, and leaves the others'. */
  setAll(summaries: SessionSummary[], hostId?: string | null): void
  upsert(summary: SessionSummary): void
  remove(sessionId: string): void
  refresh(): Promise<void>
  /**
   * Shows the session archived before the host has closed it, with the sub-sessions it leaves in
   * the list on their own; the returned function says how the host's archive went, and one that
   * failed brings them back.
   */
  archiveNow(sessionId: string, leaving?: readonly string[]): (archived: boolean) => void
}

/** Sessions archived here that the host has not answered for yet, with when. */
const archiving = new Map<string, number>()

/**
 * Sub-sessions an archive here leaves in the list, by that archive's time, with their parent and
 * the parent the host last reported for them.
 */
const leaving = new Map<string, { at: number; parentId: string; reported: string | null }>()

/**
 * A summary as the list shows it: one archived here stays archived, and a sub-session it leaves
 * stays on its own, until the host answers.
 */
function listed(summary: SessionSummary): SessionSummary {
  const at = archiving.get(summary.id)
  const shown = at === undefined || summary.archivedAt ? summary : { ...summary, archivedAt: at }
  const left = leaving.get(summary.id)
  if (!left) return shown
  left.reported = summary.parentId
  return shown.parentId === null ? shown : { ...shown, parentId: null }
}

/** Sessions listed under their projects: a routine's runs and a task's steps are listed elsewhere. */
export function listedOrigin(summary: Pick<SessionSummary, 'origin'>): boolean {
  return summary.origin !== 'routine' && summary.origin !== 'task'
}

export const useSessionsStore = create<SessionsStore>()((set, get) => ({
  byId: {},
  loaded: false,
  error: null,
  setAll(summaries, hostId = null) {
    // The list leaves out a routine's run sessions; one that is open stays for its view, which
    // the host still knows, and its removal comes as a session.removed event.
    const kept = (summary: SessionSummary) =>
      hostOfPath(summary.projectPath) !== hostId || (hostId === null && !listedOrigin(summary))
    set((state) => ({
      byId: {
        ...Object.fromEntries(Object.entries(state.byId).filter(([, summary]) => kept(summary))),
        ...Object.fromEntries(summaries.map((summary) => [summary.id, listed(summary)])),
      },
      loaded: hostId === null ? true : state.loaded,
      error: hostId === null ? null : state.error,
    }))
  },
  upsert(summary) {
    set((state) => ({ byId: { ...state.byId, [summary.id]: listed(summary) } }))
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
    let summaries: SessionSummary[]
    try {
      summaries = await host('sessions.list', {})
    } catch (error) {
      set({ error: errorMessage(error) })
      throw error
    }
    useSessionsStore.getState().setAll(summaries)
  },
  archiveNow(sessionId, leave = []) {
    const at = Date.now()
    archiving.set(sessionId, at)
    const parents = new Map<string, string>()
    for (const id of leave) {
      const parentId = get().byId[id]?.parentId
      if (!parentId) continue
      parents.set(id, parentId)
      leaving.set(id, { at, parentId, reported: parentId })
    }
    const mark = (from: number | null, to: number | null) =>
      set((state) => {
        const summary = state.byId[sessionId]
        if (!summary || summary.archivedAt !== from) return state
        return { byId: { ...state.byId, [sessionId]: { ...summary, archivedAt: to } } }
      })
    const reparent = (ids: readonly string[], back: boolean) =>
      set((state) => {
        const byId = { ...state.byId }
        for (const id of ids) {
          const summary = byId[id]
          const parentId = parents.get(id)
          if (summary && parentId) byId[id] = { ...summary, parentId: back ? parentId : null }
        }
        return { byId }
      })
    mark(null, at)
    reparent([...parents.keys()], false)
    return (archived) => {
      if (archiving.get(sessionId) !== at) return
      archiving.delete(sessionId)
      // A host from before archiving alone archives the whole tree, and says nothing of the
      // sub-sessions, which go back under the session.
      const back = [...parents.keys()].filter((id) => {
        const left = leaving.get(id)
        if (left?.at !== at) return false
        leaving.delete(id)
        return !archived || left.reported !== null
      })
      if (!archived) mark(at, null)
      reparent(back, true)
    }
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
      listedOrigin(s) &&
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
    (s) => listedOrigin(s),
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
      (s) => listedOrigin(s),
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

/** Every top-level session on any host that is not archived, as trees, pinned ones included. */
export function liveTree(byId: Record<string, SessionSummary>): SessionNode[] {
  return buildTree(
    byId,
    (s) => listedOrigin(s),
    (s) => !s.archivedAt,
  )
}

/** Whether the session is a pinned top-level session not archived, or one of its sub-sessions. */
export function inPinnedTree(byId: Record<string, SessionSummary>, s: SessionSummary): boolean {
  let root = s
  while (root.parentId && byId[root.parentId]) root = byId[root.parentId]!
  return !!root.pinnedAt && !root.archivedAt
}

/**
 * The sub-sessions right under a session that the list shows, reached through its subagents,
 * which belong to it: the ones archiving it alone leaves in the list. One a window prepared and
 * never sent goes with it.
 */
export function listedSubSessions(
  byId: Record<string, SessionSummary>,
  sessionId: string,
): SessionSummary[] {
  const all = Object.values(byId)
  const under = (id: string): SessionSummary[] =>
    all
      .filter((s) => s.parentId === id)
      .flatMap((s) =>
        s.origin === 'subagent' ? under(s.id) : s.archivedAt || s.prepared ? [] : [s],
      )
  return under(sessionId)
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

/**
 * A host's archived sessions, this computer's by default, latest archived first: the top-level
 * ones, and sub-sessions archived on their own while their parent is not. One archived with its
 * parent stays inside the parent's entry.
 */
export function archivedSessions(
  byId: Record<string, SessionSummary>,
  hostId: string | null = null,
): SessionSummary[] {
  return Object.values(byId)
    .filter(
      (s) =>
        listedOrigin(s) &&
        s.origin !== 'subagent' &&
        !!s.archivedAt &&
        hostOfSession(s) === hostId &&
        !(s.parentId && sessionArchived(byId, s.parentId)),
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

/**
 * `next` with every node that shows the same as in `previous` taken from there, so a row whose
 * session did not change keeps its node and skips its render.
 */
export function keepSameNodes(
  previous: readonly SessionNode[],
  next: readonly SessionNode[],
): SessionNode[] {
  const before = new Map(previous.map((node) => [node.summary.id, node]))
  return next.map((node) => {
    const old = before.get(node.summary.id)
    return old && sameNode(old, node) ? old : node
  })
}

function sameNode(a: SessionNode, b: SessionNode): boolean {
  return (
    a.summary === b.summary &&
    a.permissionCount === b.permissionCount &&
    a.running === b.running &&
    a.own.permissionCount === b.own.permissionCount &&
    a.own.running === b.own.running &&
    a.subagents.length === b.subagents.length &&
    a.subagents.every((agent, i) => agent === b.subagents[i]) &&
    a.children.length === b.children.length &&
    a.children.every((child, i) => sameNode(child, b.children[i]!))
  )
}

/** A row of a sidebar group: a session with its sub-sessions, or a task with its steps. */
export type SidebarRow =
  | { kind: 'session'; id: string; node: SessionNode }
  | { kind: 'task'; id: string; task: TaskSummary }

/** A group's sessions and tasks in one list, by `order` of each. */
export function sidebarRows(
  nodes: readonly SessionNode[],
  tasks: readonly TaskSummary[],
  order: (row: SidebarRow) => number,
): SidebarRow[] {
  return [
    ...nodes.map((node): SidebarRow => ({ kind: 'session', id: node.summary.id, node })),
    ...tasks.map((task): SidebarRow => ({ kind: 'task', id: task.id, task })),
  ].sort((a, b) => order(a) - order(b))
}

/** Latest activity first, as a project's group lists its rows. */
export const byActivity = (row: SidebarRow): number =>
  -(row.kind === 'session' ? row.node.summary.updatedAt : row.task.updatedAt)

/** In the order they were pinned, as Pinned lists its rows. */
export const byPin = (row: SidebarRow): number =>
  (row.kind === 'session' ? row.node.summary.pinnedAt : row.task.pinnedAt) ?? 0

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

/** The key of a host's heading in `collapsedProjects`; no folder's path can take it. */
export function hostGroup(hostId: string | null): string {
  return `host:${hostId ?? THIS_COMPUTER}`
}

/** The list's one Tab stop: a row by its id, as `visibleOrder` names it, or a group's header. */
export type SidebarTabStop = { kind: 'session'; id: string } | { kind: 'group'; key: string }

/**
 * The rows the sidebar lists, in its order: Pinned, then each project's, then No project's. A
 * collapsed group, parent or task leaves out the rows it hides. A row is a session's id, a task's,
 * or a task's step: its session's id, or `taskId/stepId` for a person's step.
 */
export function visibleOrder(
  view: SidebarView,
  byId: Record<string, SessionSummary>,
  projects: readonly Project[],
  tasks: Record<string, TaskSummary> = {},
): string[] {
  const expanded = (id: string) => view.expandedParents[id] ?? false
  const hosts = view.hosts ?? [null]
  const shown = (node: SessionNode) => hosts.includes(hostOfSession(node.summary))
  const shownTask = (task: TaskSummary) => hosts.includes(hostOfPath(task.projectPath))
  const reachable = (path: string) => !view.away?.includes(hostOfPath(path) ?? '')
  const flatten = (rows: SidebarRow[], open = true): string[] =>
    rows.flatMap((row) =>
      row.kind === 'session'
        ? flattenTree([row.node], open ? expanded : () => false)
        : [
            row.id,
            ...(open && taskExpanded(view, row.id, byId)
              ? startedSteps(row.task).map((step) => step.id)
              : []),
          ],
    )
  const projectRows = (project: Project): string[] =>
    view.collapsedProjects[project.path]
      ? []
      : flatten(
          sidebarRows(
            sessionTree(byId, project.path),
            listedTasks(tasks, project.path),
            byActivity,
          ),
        )
  const order = [
    ...(view.hosts
      ? flatten(
          sidebarRows(
            needsYouTree(byId).filter((n) => shown(n) && reachable(n.summary.projectPath)),
            needingTasks(tasks).filter((t) => shownTask(t) && reachable(t.projectPath)),
            byActivity,
          ),
          false,
        )
      : []),
    ...(view.collapsedProjects[PINNED_GROUP]
      ? []
      : [
          ...pinnedProjects(projects, hosts).flatMap(projectRows),
          ...flatten(
            sidebarRows(
              pinnedTree(byId).filter(shown),
              pinnedTasks(tasks).filter(shownTask),
              byPin,
            ),
          ),
        ]),
    ...hosts.flatMap((hostId) =>
      view.collapsedProjects[hostGroup(hostId)]
        ? []
        : [
            ...projects
              .filter((p) => p.pinnedAt == null && hostOfPath(p.path) === hostId)
              .flatMap(projectRows),
            ...(view.collapsedProjects[noProjectGroup(hostId)]
              ? []
              : flattenTree(sessionTree(byId, null, hostId), expanded)),
          ],
    ),
  ]
  // A row Needs you lists is listed in its project as well; the keys visit it once.
  return [...new Set(order)]
}

/**
 * The list's one Tab stop: the row in front while the list shows it, a session's, a task's or a
 * step's; otherwise the first group header, then no stop at all while the list has no rows.
 */
export function sidebarTabStop(
  view: SidebarView,
  byId: Record<string, SessionSummary>,
  projects: readonly Project[],
  tasks: Record<string, TaskSummary> = {},
): SidebarTabStop | null {
  const order = visibleOrder(view, byId, projects, tasks)
  const front =
    view.main.kind === 'session'
      ? view.main.sessionId
      : view.main.kind === 'task'
        ? view.main.taskId
        : null
  if (front !== null && order.includes(front)) return { kind: 'session', id: front }
  const hosts = view.hosts ?? [null]
  const shown = (node: SessionNode) => hosts.includes(hostOfSession(node.summary))
  const shownTask = (task: TaskSummary) => hosts.includes(hostOfPath(task.projectPath))
  if (
    projects.some((p) => p.pinnedAt != null && hosts.includes(hostOfPath(p.path))) ||
    pinnedTree(byId).some(shown) ||
    pinnedTasks(tasks).some(shownTask)
  ) {
    return { kind: 'group', key: PINNED_GROUP }
  }
  let firstProject: Project | undefined
  for (const hostId of hosts) {
    if (view.hosts && view.collapsedProjects[hostGroup(hostId)]) {
      return { kind: 'group', key: hostGroup(hostId) }
    }
    const own = projects.filter((p) => p.pinnedAt == null && hostOfPath(p.path) === hostId)
    firstProject ??= own[0]
    const project = own.find(
      (p) => sessionTree(byId, p.path).length > 0 || listedTasks(tasks, p.path).length > 0,
    )
    if (project) return { kind: 'group', key: project.path }
    if (sessionTree(byId, null, hostId).length > 0) {
      return { kind: 'group', key: noProjectGroup(hostId) }
    }
  }
  return firstProject ? { kind: 'group', key: firstProject.path } : null
}

export function sessionTitle(summary: Pick<SessionSummary, 'title'>): string {
  return summary.title?.trim() || i18n.t('app:newSession')
}
