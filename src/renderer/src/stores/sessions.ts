import { create } from 'zustand'
import {
  isActivelyRunning,
  type NoProject,
  type Project,
  type SessionSummary,
} from '@shared/agent-host'
import { harnessOf, type HarnessId } from '@shared/thread'
import type { TaskSummary } from '@shared/workflow'
import { errorMessage, host } from '@renderer/lib/host'
import { hostOfPath } from '@renderer/lib/host-paths'
import { i18n } from '@renderer/lib/i18n'
import {
  findProjectForPath,
  findProjectForSession,
  noProjectPinned,
  pinnedFolders,
  projectFolders,
  projectOwnsPath,
  type PinnedFolder,
} from './projects'
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

/** Shallow equality for session summaries so identical `session.summary` pushes keep `byId` stable. */
function sameSummary(a: SessionSummary, b: SessionSummary): boolean {
  if (a === b) return true
  const keysA = Object.keys(a) as (keyof SessionSummary)[]
  const keysB = Object.keys(b) as (keyof SessionSummary)[]
  if (keysA.length !== keysB.length) return false
  for (const key of keysA) {
    const va = a[key]
    const vb = b[key]
    if (va === vb) continue
    if (key === 'routine' && va && vb && typeof va === 'object' && typeof vb === 'object') {
      const ra = va as NonNullable<SessionSummary['routine']>
      const rb = vb as NonNullable<SessionSummary['routine']>
      if (
        ra.routineId === rb.routineId &&
        ra.trigger === rb.trigger &&
        ra.scheduledFor === rb.scheduledFor
      ) {
        continue
      }
    }
    return false
  }
  return true
}

export interface HarnessSessionCount {
  harnessId: HarnessId
  total: number
  running: number
}

interface SessionIndex {
  byProject: Map<string, SessionSummary[]>
  byOwner: Map<string, SessionSummary[]>
  scratchByHost: Map<string | null, SessionSummary[]>
  hasListedScratchByHost: Set<string | null>
  pinnedRelated: SessionSummary[]
  needsYouRelated: SessionSummary[]
  localHarnessCounts: HarnessSessionCount[]
  projectTrees: Map<string, SessionNode[]>
  scratchTrees: Map<string | null, SessionNode[]>
  pinnedTree?: SessionNode[]
  needsYouTree?: SessionNode[]
}

const EMPTY_SUMMARIES: SessionSummary[] = []
const sessionIndexes = new WeakMap<Record<string, SessionSummary>, SessionIndex>()
const harnessCountCache = new Map<string, HarnessSessionCount>()

function internHarnessCount(
  harnessId: HarnessId,
  total: number,
  running: number,
): HarnessSessionCount {
  const key = `${harnessId}:${total}:${running}`
  let entry = harnessCountCache.get(key)
  if (!entry) {
    if (harnessCountCache.size > 256) harnessCountCache.clear()
    entry = { harnessId, total, running }
    harnessCountCache.set(key, entry)
  }
  return entry
}

function indexOf(byId: Record<string, SessionSummary>): SessionIndex {
  let index = sessionIndexes.get(byId)
  if (index) return index

  const byProject = new Map<string, SessionSummary[]>()
  const byOwner = new Map<string, SessionSummary[]>()
  const scratchByHost = new Map<string | null, SessionSummary[]>()
  const hasListedScratchByHost = new Set<string | null>()
  const pinnedRelated: SessionSummary[] = []
  const needsYouSet = new Set<SessionSummary>()
  const localCounts = new Map<HarnessId, { total: number; running: number }>()

  for (const s of Object.values(byId)) {
    let list = byProject.get(s.projectPath)
    if (!list) byProject.set(s.projectPath, (list = []))
    list.push(s)

    if (s.projectOwner) {
      let owned = byOwner.get(s.projectOwner)
      if (!owned) byOwner.set(s.projectOwner, (owned = []))
      owned.push(s)
    }

    const hostId = hostOfSession(s)
    if (s.scratch) {
      let scratchList = scratchByHost.get(hostId)
      if (!scratchList) scratchByHost.set(hostId, (scratchList = []))
      scratchList.push(s)
      if (listedOrigin(s) && !s.archivedAt) hasListedScratchByHost.add(hostId)
    }

    if (inPinnedTree(byId, s)) pinnedRelated.push(s)

    if (s.permissionCount > 0 || s.attention === 'error') {
      let at: SessionSummary | undefined = s
      while (at && !needsYouSet.has(at)) {
        needsYouSet.add(at)
        at = at.parentId ? byId[at.parentId] : undefined
      }
    }

    if (hostId === null) {
      const harnessId = harnessOf(s.agentId)
      let counts = localCounts.get(harnessId)
      if (!counts) localCounts.set(harnessId, (counts = { total: 0, running: 0 }))
      counts.total++
      if (s.status === 'running' || s.status === 'awaiting_permission') counts.running++
    }
  }

  const localHarnessCounts = [...localCounts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([harnessId, { total, running }]) => internHarnessCount(harnessId, total, running))

  index = {
    byProject,
    byOwner,
    scratchByHost,
    hasListedScratchByHost,
    pinnedRelated,
    needsYouRelated: [...needsYouSet],
    localHarnessCounts,
    projectTrees: new Map(),
    scratchTrees: new Map(),
  }
  sessionIndexes.set(byId, index)
  return index
}

/** O(1) indexed lookup of a project's or host scratch group's sessions for sidebar selectors. */
export function projectSummaries(
  byId: Record<string, SessionSummary>,
  projectPath: string | null,
  hostId: string | null = null,
): SessionSummary[] {
  const index = indexOf(byId)
  return projectPath === null
    ? (index.scratchByHost.get(hostId) ?? EMPTY_SUMMARIES)
    : (index.byProject.get(projectPath) ?? EMPTY_SUMMARIES)
}

/**
 * Sessions belonging to a project group: across its primary path, any additional source folders,
 * and historical sessions owned by it whose secondary folder was later removed (unless another
 * project now directly owns that folder).
 */
export function projectGroupSummaries(
  byId: Record<string, SessionSummary>,
  project: Project | null,
  hostId: string | null = null,
  allProjects?: readonly Project[],
): SessionSummary[] {
  const index = indexOf(byId)
  if (project === null) return index.scratchByHost.get(hostId) ?? EMPTY_SUMMARIES
  const folders = projectFolders(project)
  const owned = index.byOwner.get(project.path)
  if (folders.length === 1 && (!owned || owned.length === 0)) {
    return index.byProject.get(project.path) ?? EMPTY_SUMMARIES
  }
  const seen = new Set<string>()
  const out: SessionSummary[] = []
  for (const folder of folders) {
    for (const s of index.byProject.get(folder) ?? EMPTY_SUMMARIES) {
      if (seen.has(s.id)) continue
      seen.add(s.id)
      out.push(s)
    }
  }
  for (const s of owned ?? EMPTY_SUMMARIES) {
    if (seen.has(s.id) || s.scratch) continue
    if (allProjects) {
      const direct = findProjectForPath(allProjects, s.projectPath)
      if (direct && direct.path !== project.path) continue
    }
    seen.add(s.id)
    out.push(s)
  }
  return out
}

/** O(1) indexed lookup of sessions belonging to pinned trees. */
export function pinnedSummaries(byId: Record<string, SessionSummary>): SessionSummary[] {
  return indexOf(byId).pinnedRelated
}

/** O(1) indexed lookup of sessions waiting for user action or errored, plus their ancestors. */
export function needsYouSummaries(byId: Record<string, SessionSummary>): SessionSummary[] {
  return indexOf(byId).needsYouRelated
}

/** O(1) indexed check for whether `hostId` has any visible No project session. */
export function hasNoProjectSessions(
  byId: Record<string, SessionSummary>,
  hostId: string | null,
): boolean {
  return indexOf(byId).hasListedScratchByHost.has(hostId)
}

/** Indexed subset of `hosts` that have visible No project sessions. */
export function hostsWithNoProjectSessions(
  byId: Record<string, SessionSummary>,
  hosts: readonly (string | null)[],
): (string | null)[] {
  const set = indexOf(byId).hasListedScratchByHost
  return hosts.filter((hostId) => set.has(hostId))
}

/** Per-harness total and running session counts on this computer, cached per `byId` reference. */
export function localHarnessCounts(byId: Record<string, SessionSummary>): HarnessSessionCount[] {
  return indexOf(byId).localHarnessCounts
}

function isRunningStatus(status: SessionSummary['status']): boolean {
  return status === 'running' || status === 'awaiting_permission'
}

function needsAttention(summary: SessionSummary): boolean {
  return summary.permissionCount > 0 || summary.attention === 'error'
}

function replaceInList(
  list: readonly SessionSummary[],
  id: string,
  next: SessionSummary,
): SessionSummary[] {
  let replaced = false
  const out = list.map((item) => {
    if (item.id === id) {
      replaced = true
      return next
    }
    return item
  })
  if (!replaced) out.push(next)
  return out
}

/**
 * Incrementally derives a new `SessionIndex` when a single existing session updates in place
 * (status/phase/title/updatedAt/usage heartbeats). Unrelated project arrays and cached trees keep
 * their exact object references so sidebar groups skip rebuilding and re-rendering.
 */
function updateIndexForUpsert(
  prevById: Record<string, SessionSummary>,
  prevIndex: SessionIndex,
  prev: SessionSummary,
  next: SessionSummary,
): SessionIndex | null {
  if (
    prev.projectPath !== next.projectPath ||
    prev.projectOwner !== next.projectOwner ||
    prev.scratch !== next.scratch ||
    prev.parentId !== next.parentId ||
    prev.origin !== next.origin ||
    Boolean(prev.archivedAt) !== Boolean(next.archivedAt) ||
    Boolean(prev.pinnedAt) !== Boolean(next.pinnedAt) ||
    prev.agentId !== next.agentId ||
    needsAttention(prev) !== needsAttention(next) ||
    inPinnedTree(prevById, prev)
  ) {
    return null
  }

  const byProject = new Map(prevIndex.byProject)
  const prevProjectList = byProject.get(next.projectPath)
  if (!prevProjectList) return null
  byProject.set(next.projectPath, replaceInList(prevProjectList, next.id, next))

  let byOwner = prevIndex.byOwner
  if (next.projectOwner) {
    const prevOwnerList = byOwner.get(next.projectOwner)
    if (!prevOwnerList) return null
    byOwner = new Map(prevIndex.byOwner)
    byOwner.set(next.projectOwner, replaceInList(prevOwnerList, next.id, next))
  }

  const projectTrees = new Map(prevIndex.projectTrees)
  projectTrees.delete(next.projectPath)
  if (next.projectOwner) projectTrees.delete(next.projectOwner)

  let scratchByHost = prevIndex.scratchByHost
  let scratchTrees = prevIndex.scratchTrees
  const hostId = hostOfSession(next)
  if (next.scratch) {
    scratchByHost = new Map(prevIndex.scratchByHost)
    const prevScratchList = scratchByHost.get(hostId)
    if (!prevScratchList) return null
    scratchByHost.set(hostId, replaceInList(prevScratchList, next.id, next))
    scratchTrees = new Map(prevIndex.scratchTrees)
    scratchTrees.delete(hostId)
  }

  let needsYouRelated = prevIndex.needsYouRelated
  let needsYouTree = prevIndex.needsYouTree
  if (needsYouRelated.some((item) => item.id === next.id)) {
    needsYouRelated = replaceInList(needsYouRelated, next.id, next)
    needsYouTree = undefined
  }

  let localHarnessCounts = prevIndex.localHarnessCounts
  if (hostId === null) {
    const deltaRunning =
      (isRunningStatus(next.status) ? 1 : 0) - (isRunningStatus(prev.status) ? 1 : 0)
    if (deltaRunning !== 0) {
      const harnessId = harnessOf(next.agentId)
      localHarnessCounts = localHarnessCounts.map((entry) =>
        entry.harnessId === harnessId
          ? internHarnessCount(harnessId, entry.total, Math.max(0, entry.running + deltaRunning))
          : entry,
      )
    }
  }

  return {
    byProject,
    byOwner,
    scratchByHost,
    hasListedScratchByHost: prevIndex.hasListedScratchByHost,
    pinnedRelated: prevIndex.pinnedRelated,
    needsYouRelated,
    localHarnessCounts,
    projectTrees,
    scratchTrees,
    pinnedTree: prevIndex.pinnedTree,
    needsYouTree,
  }
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
    set((state) => {
      const next = listed(summary)
      const prev = state.byId[summary.id]
      if (prev && sameSummary(prev, next)) return state
      const byId = { ...state.byId, [summary.id]: next }
      const prevIndex = prev ? sessionIndexes.get(state.byId) : undefined
      if (prev && prevIndex) {
        const nextIndex = updateIndexForUpsert(state.byId, prevIndex, prev, next)
        if (nextIndex) sessionIndexes.set(byId, nextIndex)
      }
      return { byId }
    })
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
  const index = indexOf(byId)
  if (projectPath === null) {
    let cached = index.scratchTrees.get(hostId)
    if (!cached) {
      cached = buildTree(
        byId,
        index.scratchByHost.get(hostId) ?? EMPTY_SUMMARIES,
        (s) => listedOrigin(s) && s.scratch && hostOfSession(s) === hostId,
        (s) => !s.pinnedAt && !s.archivedAt,
      ).sort((a, b) => b.summary.updatedAt - a.summary.updatedAt)
      index.scratchTrees.set(hostId, cached)
    }
    return cached
  }
  let cached = index.projectTrees.get(projectPath)
  if (!cached) {
    cached = buildTree(
      byId,
      index.byProject.get(projectPath) ?? EMPTY_SUMMARIES,
      (s) => listedOrigin(s) && s.projectPath === projectPath,
      (s) => !s.pinnedAt && !s.archivedAt,
    ).sort((a, b) => b.summary.updatedAt - a.summary.updatedAt)
    index.projectTrees.set(projectPath, cached)
  }
  return cached
}

/**
 * Session tree for a sidebar project group, combining its primary folder, additional source
 * folders, and historical sessions owned by it whose secondary folder was later removed.
 */
export function projectSessionTree(
  byId: Record<string, SessionSummary>,
  project: Project,
  allProjects?: readonly Project[],
): SessionNode[] {
  const index = indexOf(byId)
  const folders = projectFolders(project)
  const owned = index.byOwner.get(project.path)
  if (folders.length === 1 && (!owned || owned.length === 0)) {
    return sessionTree(byId, project.path)
  }
  const candidates = projectGroupSummaries(byId, project, null, allProjects)
  return buildTree(
    byId,
    candidates,
    (s) =>
      listedOrigin(s) &&
      !s.scratch &&
      (projectOwnsPath(project, s.projectPath) ||
        (s.projectOwner === project.path &&
          (!allProjects ||
            (findProjectForPath(allProjects, s.projectPath)?.path ?? project.path) ===
              project.path))),
    (s) => !s.pinnedAt && !s.archivedAt,
  ).sort((a, b) => b.summary.updatedAt - a.summary.updatedAt)
}

/** The pinned sessions across the projects as trees, in the order they were pinned. */
export function pinnedTree(byId: Record<string, SessionSummary>): SessionNode[] {
  const index = indexOf(byId)
  index.pinnedTree ??= buildTree(
    byId,
    index.pinnedRelated,
    (s) => listedOrigin(s),
    (s) => !!s.pinnedAt && !s.archivedAt,
  ).sort((a, b) => (a.summary.pinnedAt ?? 0) - (b.summary.pinnedAt ?? 0))
  return index.pinnedTree
}

/**
 * The sessions on any host that wait for a permission answer, here or in a sub-session, or that
 * failed: the top-level ones, the latest first. They stay listed in their projects as well.
 */
export function needsYouTree(byId: Record<string, SessionSummary>): SessionNode[] {
  const index = indexOf(byId)
  index.needsYouTree ??= buildTree(
    byId,
    index.needsYouRelated,
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
  return index.needsYouTree
}

/** Every top-level session on any host that is not archived, as trees, pinned ones included. */
export function liveTree(byId: Record<string, SessionSummary>): SessionNode[] {
  return buildTree(
    byId,
    Object.values(byId),
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
  candidates: readonly SessionSummary[],
  within: (s: SessionSummary) => boolean,
  rootKept: (s: SessionSummary) => boolean,
): SessionNode[] {
  const children = new Map<string, SessionSummary[]>()
  const roots: SessionSummary[] = []
  for (const s of candidates) {
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
  return isActivelyRunning(summary)
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

/**
 * A row of a sidebar group: a session with its sub-sessions, or a task with its steps and, when a
 * suggestion card in it started the task, the conversation it started from, whose row it took.
 */
export type SidebarRow =
  | { kind: 'session'; id: string; node: SessionNode }
  | { kind: 'task'; id: string; task: TaskSummary; origin?: SessionNode }

/**
 * A group's sessions and tasks in one list, by `order` of each. A task started from a session of
 * the same list takes that session's row, the session hanging under it; one session goes under
 * one task, the latest.
 */
export function sidebarRows(
  nodes: readonly SessionNode[],
  tasks: readonly TaskSummary[],
  order: (row: SidebarRow) => number,
): SidebarRow[] {
  const byId = new Map(nodes.map((node) => [node.summary.id, node]))
  const origins = new Map<string, SessionNode>()
  const taken = new Set<string>()
  for (const task of [...tasks].sort((a, b) => b.createdAt - a.createdAt)) {
    const id = task.from?.sessionId
    const node = id ? byId.get(id) : undefined
    if (!node || taken.has(node.summary.id)) continue
    origins.set(task.id, node)
    taken.add(node.summary.id)
  }
  return [
    ...nodes
      .filter((node) => !taken.has(node.summary.id))
      .map((node): SidebarRow => ({ kind: 'session', id: node.summary.id, node })),
    ...tasks.map((task): SidebarRow => {
      const origin = origins.get(task.id)
      return origin
        ? { kind: 'task', id: task.id, task, origin }
        : { kind: 'task', id: task.id, task }
    }),
  ].sort((a, b) => order(a) - order(b))
}

/** Latest activity first, as a project's group lists its rows; a task counts its conversation's. */
export const byActivity = (row: SidebarRow): number =>
  -(row.kind === 'session'
    ? row.node.summary.updatedAt
    : Math.max(row.task.updatedAt, row.origin?.summary.updatedAt ?? 0))

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
 * The rows the sidebar lists, in its order: Pinned, then No project's, then each project's. A
 * collapsed group, parent or task leaves out the rows it hides. A row is a session's id, a task's,
 * or a task's step: its session's id, or `taskId/stepId` for a person's step.
 */
export function visibleOrder(
  view: SidebarView,
  byId: Record<string, SessionSummary>,
  projects: readonly Project[],
  tasks: Record<string, TaskSummary> = {},
  noProjects: Readonly<Record<string, NoProject>> = {},
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
            ...(open && taskExpanded(view, row.id, byId, row.origin?.summary.id)
              ? [
                  ...(row.origin ? [row.origin.summary.id] : []),
                  ...startedSteps(row.task).map((step) => step.id),
                ]
              : []),
          ],
    )
  const projectRows = (project: Project): string[] =>
    view.collapsedProjects[project.path]
      ? []
      : flatten(
          sidebarRows(
            projectSessionTree(byId, project, projects),
            listedTasks(tasks, projectFolders(project)),
            byActivity,
          ),
        )
  const noProjectRows = (hostId: string | null): string[] =>
    view.collapsedProjects[noProjectGroup(hostId)]
      ? []
      : flattenTree(sessionTree(byId, null, hostId), expanded)
  const folderRows = (folder: PinnedFolder): string[] =>
    folder.project ? projectRows(folder.project) : noProjectRows(folder.hostId)
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
          ...pinnedFolders(projects, noProjects, hosts).flatMap(folderRows),
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
            ...(noProjectPinned(noProjects, hostId) ? [] : noProjectRows(hostId)),
            ...projects
              .filter((p) => p.pinnedAt == null && hostOfPath(p.path) === hostId)
              .flatMap(projectRows),
          ],
    ),
  ]
  // A row Needs you lists is listed in its project as well; the keys visit it once.
  return [...new Set(order)]
}

/**
 * Fast O(1) check for the common case where the active top-level session is directly visible
 * under its project or scratch group, avoiding a full `visibleOrder` build on every summary tick.
 */
function isFastVisibleSession(
  view: SidebarView,
  byId: Record<string, SessionSummary>,
  projects: readonly Project[],
  tasks: Record<string, TaskSummary>,
  noProjects: Readonly<Record<string, NoProject>>,
  sessionId: string,
): boolean {
  const s = byId[sessionId]
  if (!s || s.archivedAt || !listedOrigin(s) || s.origin === 'subagent' || s.parentId) return false
  const hosts = view.hosts ?? [null]
  const hostId = hostOfSession(s)
  if (!hosts.includes(hostId)) return false
  // If any task adopted this session as its origin, fall back to full visibleOrder.
  for (const key in tasks) {
    if (tasks[key]?.from?.sessionId === sessionId) return false
  }
  if (s.pinnedAt) return !view.collapsedProjects[PINNED_GROUP]
  if (s.scratch) {
    const pinned = noProjectPinned(noProjects, hostId)
    if (pinned && view.collapsedProjects[PINNED_GROUP]) return false
    if (!pinned && view.collapsedProjects[hostGroup(hostId)]) return false
    return !view.collapsedProjects[noProjectGroup(hostId)]
  }
  const project = findProjectForSession(projects, s)
  if (!project) return false
  if (project.pinnedAt != null) {
    if (view.collapsedProjects[PINNED_GROUP]) return false
  } else if (view.collapsedProjects[hostGroup(hostId)]) {
    return false
  }
  return !view.collapsedProjects[project.path]
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
  noProjects: Readonly<Record<string, NoProject>> = {},
): SidebarTabStop | null {
  if (
    view.main.kind === 'session' &&
    isFastVisibleSession(view, byId, projects, tasks, noProjects, view.main.sessionId)
  ) {
    return { kind: 'session', id: view.main.sessionId }
  }
  const order = visibleOrder(view, byId, projects, tasks, noProjects)
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
  // A pinned No project shows only while it has sessions; a pinned project shows without.
  if (
    pinnedFolders(projects, noProjects, hosts).some(
      (folder) => folder.project || sessionTree(byId, null, folder.hostId).length > 0,
    ) ||
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
    if (!noProjectPinned(noProjects, hostId) && sessionTree(byId, null, hostId).length > 0) {
      return { kind: 'group', key: noProjectGroup(hostId) }
    }
    const own = projects.filter((p) => p.pinnedAt == null && hostOfPath(p.path) === hostId)
    firstProject ??= own[0]
    const project = own.find(
      (p) =>
        projectSessionTree(byId, p, projects).length > 0 ||
        listedTasks(tasks, projectFolders(p)).length > 0,
    )
    if (project) return { kind: 'group', key: project.path }
  }
  return firstProject ? { kind: 'group', key: firstProject.path } : null
}

export function sessionTitle(summary: Pick<SessionSummary, 'title'>): string {
  return summary.title?.trim() || i18n.t('app:newSession')
}
