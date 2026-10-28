import { create } from 'zustand'
import type { AgentId } from '@shared/thread'
import { markSwitchStart } from '@renderer/app/perf'
import {
  GROUPINGS,
  SORTS,
  type ArtifactGrouping,
  type ArtifactSort,
} from '@renderer/features/artifacts/model'
import {
  allPanes,
  closePane as closePaneInLayout,
  createLayout,
  dropView as dropViewInLayout,
  findPane,
  focusPane as focusPaneInLayout,
  focusedPane,
  isSplit,
  newSessionPane,
  openBeside as openBesideInLayout,
  paneOrder,
  paneWithSession,
  readLayout,
  resizeColumns,
  resizePanes,
  saveLayout,
  setPaneView as setPaneViewInLayout,
  showView as showViewInLayout,
  type Layout,
  type PaneView,
  type Place,
} from '@renderer/features/split/layout'
import { readJson, writeJson } from '@renderer/lib/storage'
import { useArtifactsStore } from '@renderer/stores/artifacts'

type PageView =
  // At launch, until the last session or New session replaces it.
  | { kind: 'launch' }
  | { kind: 'session'; sessionId: string }
  // The New session screen; the session is created on the first send. With `noProject`, in a
  // scratch folder of its own rather than the selected project; with `parentId`, as a sub-session
  // of that session, in its project.
  | { kind: 'new'; agentId: AgentId | null; noProject: boolean; parentId?: string }
  | { kind: 'usage' } // the usage page, opened from the sidebar
  // The Routines page, opened from the sidebar; with a null routine id, New routine.
  | { kind: 'routines' }
  | { kind: 'routine'; routineId: string | null }
  // The Artifacts page, opened from the sidebar; with `deleted`, its Recently deleted view.
  | { kind: 'artifacts'; deleted?: true }

// An artifact in the viewer, which Back leaves for what the main area showed before; `history`
// opens it with its version history.
export type MainView =
  PageView | { kind: 'artifact'; id: string; back: PageView; history?: boolean }

// The No project and Pinned groups' keys in `collapsedProjects`, which no folder's path can take.
export const NO_PROJECT_GROUP = 'no-project'
export const PINNED_GROUP = 'pinned'

/** What the side panel shows; one pane at a time. An artifact's pane opens from the thread. */
export type SidePane = 'terminal' | 'files' | 'browser' | 'artifact'

export type SettingsSection =
  | 'general'
  | 'appearance'
  | 'agents'
  | 'terminal'
  | 'git'
  | 'notifications'
  | 'usage'
  | 'mcp'
  | 'archived'
  | 'sharing'
  | 'browser'
  | 'advanced'
  | 'about'

interface ViewStore {
  projectPath: string | null
  main: MainView
  /** Columns of panes, and the pane in focus; the pane's view mirrors `main`. */
  layout: Layout
  /** The panes the split has room to show, as it measures its box. */
  visiblePanes: string[]
  /** The split's side pane and artifact, while it has two panes or more. */
  splitSidePane: SidePane | null
  splitSideArtifact: string | null
  /**
   * `section` is the page shown while open and the one to return to; null until one is chosen.
   * `item` is the page of one item of the section, such as an agent's or a server's, instead of
   * the list.
   */
  settings: { open: boolean; section: SettingsSection | null; item: string | null }
  /** The shortcuts dialog, over whatever the window shows. Not persisted. */
  shortcutsOpen: boolean
  sidebarCollapsed: boolean
  /** Groups the user collapsed, by path, `NO_PROJECT_GROUP` or `PINNED_GROUP`; open by default. */
  collapsedProjects: Record<string, true>
  /** Parent sessions the user collapsed or expanded; others follow activity. */
  expandedParents: Record<string, boolean>
  /** The open side pane per project; none when the panel is closed. */
  sidePane: Record<string, SidePane>
  /** The artifact each project's artifact pane shows. */
  sideArtifact: Record<string, string>
  sidePaneMaximized: boolean
  /** How the Artifacts page groups and sorts, for the whole app. */
  artifactsView: { group: ArtifactGrouping; sort: ArtifactSort }
}

interface Persisted {
  projectPath: string | null
  lastSessionId: string | null
  sidebarCollapsed: boolean
  collapsedProjects: Record<string, true>
  expandedParents: Record<string, boolean>
  sidePane: Record<string, SidePane>
  splitSidePane?: SidePane | null
  /** One pane per column, the pane in focus; read back as the split a restart opens. */
  layout?: unknown
  artifactsView?: { group?: string; sort?: string }
  /** Read once from versions before the Files pane, when the side panel held only the terminal. */
  terminalOpen?: Record<string, boolean>
}

const KEY = 'view:v1'
const saved = readJson<Partial<Persisted>>(KEY, {})

/** A layout stored by an earlier run, as it was written; `restoredLayout` reads it. */
export const savedLayout: unknown = saved.layout
/** The session an earlier run showed, for saves made before the split view. */
export const lastSessionId = saved.lastSessionId ?? null

export const useViewStore = create<ViewStore>()(() => ({
  projectPath: saved.projectPath ?? null,
  main: { kind: 'launch' },
  layout: readLayout(saved.layout) ?? createLayout(),
  visiblePanes: [],
  splitSidePane: saved.splitSidePane ?? null,
  splitSideArtifact: null,
  settings: { open: false, section: null, item: null },
  shortcutsOpen: false,
  sidebarCollapsed: saved.sidebarCollapsed ?? false,
  collapsedProjects: saved.collapsedProjects ?? {},
  expandedParents: saved.expandedParents ?? {},
  sidePane:
    saved.sidePane ??
    Object.fromEntries(
      Object.entries(saved.terminalOpen ?? {})
        .filter(([, open]) => open)
        .map(([path]) => [path, 'terminal' as const]),
    ),
  sideArtifact: {},
  sidePaneMaximized: false,
  artifactsView: {
    group: oneOf(GROUPINGS, saved.artifactsView?.group, 'project-session'),
    sort: oneOf(SORTS, saved.artifactsView?.sort, 'newest'),
  },
}))

function oneOf<T extends string>(values: readonly T[], value: string | undefined, fallback: T): T {
  return values.includes(value as T) ? (value as T) : fallback
}

let saveTimer: ReturnType<typeof setTimeout> | undefined
useViewStore.subscribe((state) => {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    const persisted: Persisted = {
      projectPath: state.projectPath,
      lastSessionId: state.main.kind === 'session' ? state.main.sessionId : null,
      sidebarCollapsed: state.sidebarCollapsed,
      collapsedProjects: state.collapsedProjects,
      expandedParents: state.expandedParents,
      // An artifact's pane is not remembered: it opens from the thread, for the work at hand.
      sidePane: Object.fromEntries(
        Object.entries(state.sidePane).filter(([, pane]) => pane !== 'artifact'),
      ),
      splitSidePane: state.splitSidePane === 'artifact' ? null : (state.splitSidePane ?? null),
      layout: saveLayout(state.layout),
      artifactsView: state.artifactsView,
    }
    writeJson(KEY, persisted)
  }, 300)
})

/** Whether the main area shows sessions, New session or a session being created. */
export function sessionsShown(main: MainView): boolean {
  return main.kind === 'session' || main.kind === 'new'
}

/** The main view and selected project of the pane in focus. */
function mirror(s: ViewStore, layout: Layout): Pick<ViewStore, 'main' | 'projectPath'> {
  const view = focusedPane(layout).view
  if (view.kind === 'session') {
    return { main: { kind: 'session', sessionId: view.sessionId }, projectPath: view.projectPath }
  }
  return {
    main: {
      kind: 'new',
      agentId: view.agentId,
      noProject: view.noProject,
      ...(view.parentId ? { parentId: view.parentId } : {}),
    },
    projectPath: view.projectPath ?? s.projectPath,
  }
}

/**
 * The side panel's pane and artifact as the split changes: it takes the focused project's when the
 * split starts, keeps its own as the focus moves, and hands it to the remaining pane's project
 * when the split ends, so the panel never changes by itself.
 */
function sidePaneChange(
  s: ViewStore,
  layout: Layout,
  projectPath: string | null,
): Partial<ViewStore> {
  const before = isSplit(s.layout)
  const after = isSplit(layout)
  if (before === after) return {}
  if (after) {
    const path = projectPath ?? ''
    return {
      splitSidePane: s.sidePane[path] ?? null,
      splitSideArtifact: s.sideArtifact[path] ?? null,
    }
  }
  const changes: Partial<ViewStore> = { splitSidePane: null, splitSideArtifact: null }
  if (!projectPath) return changes
  const sidePane = { ...s.sidePane }
  if (s.splitSidePane) sidePane[projectPath] = s.splitSidePane
  else delete sidePane[projectPath]
  const sideArtifact = { ...s.sideArtifact }
  if (s.splitSidePane === 'artifact' && s.splitSideArtifact) {
    sideArtifact[projectPath] = s.splitSideArtifact
  } else delete sideArtifact[projectPath]
  return { ...changes, sidePane, sideArtifact }
}

/**
 * A store update after the layout changed: the main view of the focus while sessions show or when
 * asked to, and the side panel the layout's change needs.
 */
function withLayout(s: ViewStore, layout: Layout, show = false): Partial<ViewStore> {
  const mirroring = show || sessionsShown(s.main)
  const changes: Partial<ViewStore> = { layout }
  if (mirroring) Object.assign(changes, mirror(s, layout))
  const projectPath = mirroring ? (changes.projectPath ?? s.projectPath) : s.projectPath
  return { ...changes, ...sidePaneChange(s, layout, projectPath) }
}

const pathShown = (s: ViewStore): string =>
  isSplit(s.layout)
    ? (focusedPane(s.layout).view.projectPath ?? s.projectPath ?? '')
    : (s.projectPath ?? '')

/** The side panel's pane, from the split while it has two panes or more, else the project's. */
export function shownSidePane(state: ViewStore): SidePane | undefined {
  return isSplit(state.layout)
    ? (state.splitSidePane ?? undefined)
    : state.sidePane[pathShown(state)]
}

/** The artifact the side panel shows, from the split or the project. */
export function shownSideArtifact(state: ViewStore): string | undefined {
  return isSplit(state.layout)
    ? (state.splitSideArtifact ?? undefined)
    : state.sideArtifact[pathShown(state)]
}

/** The sessions the layout holds, folded panes included. */
export function layoutSessions(layout: Layout): string[] {
  return allPanes(layout).flatMap((pane) =>
    pane.view.kind === 'session' ? [pane.view.sessionId] : [],
  )
}

/** The projects the panes in view work in, joined, for their git status. */
export function shownProjects(state: ViewStore): string {
  const panes = new Set(state.visiblePanes.length ? state.visiblePanes : paneOrder(state.layout))
  const paths = allPanes(state.layout).flatMap((pane) =>
    panes.has(pane.id) && pane.view.projectPath ? [pane.view.projectPath] : [],
  )
  return [...new Set(paths)].join('\n')
}

/** The projects the layout's panes work in, folded ones included. */
export function layoutProjects(layout: Layout): string[] {
  const paths = allPanes(layout).flatMap((pane) => {
    const path = pane.view.projectPath
    return path ? [path] : []
  })
  return [...new Set(paths)]
}

/** The sessions the host counts as seen: those of the panes in view, while sessions show. */
export function shownLayoutSessions(state: ViewStore): string[] {
  if (state.settings.open || !sessionsShown(state.main)) return []
  // Before the split has measured its box, every pane counts, so a launch marks nothing unread.
  const panes = new Set(state.visiblePanes.length ? state.visiblePanes : paneOrder(state.layout))
  return allPanes(state.layout).flatMap((pane) =>
    panes.has(pane.id) && pane.view.kind === 'session' && pane.view.sessionId
      ? [pane.view.sessionId]
      : [],
  )
}

export function openSession(sessionId: string, projectPath: string): void {
  const { main } = useViewStore.getState()
  if (main.kind !== 'session' || main.sessionId !== sessionId) markSwitchStart(sessionId)
  useViewStore.setState((s) => ({
    ...withLayout(s, showViewInLayout(s.layout, { kind: 'session', sessionId, projectPath }), true),
    settings: { ...s.settings, open: false },
  }))
}

/**
 * Shows the pane at that place in the split, counted column by column and top to bottom; false
 * past the last pane, which the key leaves alone.
 */
export function focusPaneAt(index: number): boolean {
  const paneId = paneOrder(useViewStore.getState().layout)[index]
  if (!paneId) return false
  focusPane(paneId)
  return true
}

/** Puts a pane in focus, which the main view follows while sessions show. */
export function focusPane(paneId: string): void {
  useViewStore.setState((s) =>
    s.layout.focus === paneId ? s : withLayout(s, focusPaneInLayout(s.layout, paneId)),
  )
}

/** Closes a pane; the focus goes to the pane before it, then the keyboard focus to its composer. */
export function closeSplitPane(paneId: string, refocusComposer = false): void {
  const { layout } = useViewStore.getState()
  if (!isSplit(layout)) return
  useViewStore.setState((s) => withLayout(s, closePaneInLayout(s.layout, paneId)))
  if (refocusComposer) {
    requestAnimationFrame(() => {
      const focused = useViewStore.getState().layout.focus
      const pane = document.querySelector<HTMLElement>(`[data-split-pane="${CSS.escape(focused)}"]`)
      const composer = pane?.querySelector<HTMLElement>(
        '[data-split-pane] .cm-content, .cm-content',
      )
      ;(composer ?? pane)?.focus()
    })
  }
}

/** Records what the split has room to show, for the host's view of the sessions. */
export function setVisiblePanes(paneIds: string[]): void {
  useViewStore.setState((s) => {
    const before = s.visiblePanes
    if (before.length === paneIds.length && before.every((id, i) => id === paneIds[i])) return s
    return { visiblePanes: paneIds }
  })
}

/** Keeps the shares a resize of the split's columns left, in the split's own shares. */
export function setColumnShares(sizes: Record<string, number>): void {
  useViewStore.setState((s) => ({ layout: resizeColumns(s.layout, sizes) }))
}

/** Keeps the shares a resize of a column's panes left. */
export function setPaneShares(columnId: string, sizes: Record<string, number>): void {
  useViewStore.setState((s) => ({ layout: resizePanes(s.layout, columnId, sizes) }))
}

/** A view dropped at a place in the split. */
export function dropViewAt(
  view: PaneView,
  place: Place,
  size: { width: number; height: number },
): void {
  useViewStore.setState((s) => {
    const layout = dropViewInLayout(s.layout, view, place, size)
    return layout ? withLayout(s, layout, true) : s
  })
}

/** Puts a session no pane shows to the right of, or below, the pane in focus. */
export function openInSplit(
  view: PaneView,
  side: 'right' | 'bottom',
  size: { width: number; height: number },
): void {
  useViewStore.setState((s) => {
    const layout = openBesideInLayout(s.layout, view, side, size)
    return layout ? withLayout(s, layout, true) : s
  })
}

/** Sets what a pane shows, from its own controls. */
export function setPaneView(paneId: string, view: PaneView): void {
  useViewStore.setState((s) => withLayout(s, setPaneViewInLayout(s.layout, paneId, view)))
}

/**
 * Closes the pane of a session that left the list, while the split holds others; in the only pane
 * the main view leaves for New session as it did before a split.
 */
export function closeLayoutSession(sessionId: string): void {
  useViewStore.setState((s) => {
    if (!isSplit(s.layout)) return s
    const pane = paneWithSession(s.layout, sessionId)
    return pane ? withLayout(s, closePaneInLayout(s.layout, pane.id), true) : s
  })
}

/** The pane's view now, for its own controls. */
export function paneViewOf(paneId: string): PaneView | undefined {
  return findPane(useViewStore.getState().layout, paneId)?.view
}

/** New session's chosen agent in a pane, which its view keeps out of focus. */
export function paneAgent(layout: Layout, paneId: string): AgentId | null {
  const view = findPane(layout, paneId)?.view
  return view?.kind === 'new' ? view.agentId : null
}

/** The agent New session in a pane starts with, from its own menu. */
export function choosePaneAgent(paneId: string, agentId: AgentId): void {
  const view = findPane(useViewStore.getState().layout, paneId)?.view
  if (view?.kind !== 'new') return
  setPaneView(paneId, { ...view, agentId })
}

/** The pane that shows New session, for the session its first message creates. */
export function newSessionAt(): string | null {
  return newSessionPane(useViewStore.getState().layout)?.id ?? null
}

/**
 * The session New session's first message created, in the pane that showed New session wherever
 * the focus went meanwhile. False when that pane closed or shows something else, so the session
 * only joins the sidebar.
 */
export function showCreatedSession(
  paneId: string,
  sessionId: string,
  projectPath: string,
): boolean {
  const { layout } = useViewStore.getState()
  const pane = findPane(layout, paneId)
  if (!pane || pane.view.kind !== 'new') return false
  useViewStore.setState((s) =>
    withLayout(
      s,
      setPaneViewInLayout(s.layout, paneId, { kind: 'session', sessionId, projectPath }),
      true,
    ),
  )
  return true
}

export function openUsage(): void {
  useViewStore.setState((s) => ({
    main: { kind: 'usage' },
    settings: { ...s.settings, open: false },
  }))
}

/** The Routines page from the sidebar: every routine. */
export function openRoutines(): void {
  useViewStore.setState((s) => ({
    main: { kind: 'routines' },
    settings: { ...s.settings, open: false },
  }))
}

/** A routine's page, or New routine with a null id. */
export function openRoutine(routineId: string | null): void {
  useViewStore.setState((s) => ({
    main: { kind: 'routine', routineId },
    settings: { ...s.settings, open: false },
  }))
}

/** The Artifacts page from the sidebar, with its whole list. */
export function openArtifacts(): void {
  useArtifactsStore.setState({ filter: '', opened: null })
  useViewStore.setState((s) => ({
    main: { kind: 'artifacts' },
    settings: { ...s.settings, open: false },
  }))
}

/** The Artifacts page's Recently deleted view; Back returns to the list. */
export function openRecentlyDeleted(deleted: boolean): void {
  useViewStore.setState({
    main: deleted ? { kind: 'artifacts', deleted: true } : { kind: 'artifacts' },
  })
}

export function setArtifactsView(patch: Partial<ViewStore['artifactsView']>): void {
  useViewStore.setState((s) => ({ artifactsView: { ...s.artifactsView, ...patch } }))
}

/** Shows an artifact in the viewer, in place of what the main area shows. */
export function openArtifact(id: string, { history = false }: { history?: boolean } = {}): void {
  useViewStore.setState((s) => ({
    main: {
      kind: 'artifact',
      id,
      back: s.main.kind === 'artifact' ? s.main.back : s.main,
      ...(history && { history }),
    },
    settings: { ...s.settings, open: false },
  }))
}

/** The viewer's Back: to what the main area showed before the artifact. */
export function closeArtifact(): void {
  useViewStore.setState((s) => (s.main.kind === 'artifact' ? { main: s.main.back } : s))
}

/**
 * The New session screen, in the given project, with No project, or in the selected project; a
 * shown one keeps its agent, and its No project unless given a project.
 */
export function openNewSession(
  projectPath: string | null,
  agentId: AgentId | null,
  noProject = false,
): void {
  useViewStore.setState((s) => ({
    ...withLayout(
      s,
      showViewInLayout(s.layout, newSessionView(s, projectPath, agentId, noProject)),
      true,
    ),
    settings: { ...s.settings, open: false },
  }))
}

/** New session for a sub-session of `parent`, in its project, with the agent the menu chose. */
export function openNewSubSession(
  parent: { id: string; projectPath: string },
  agentId: AgentId,
): void {
  const view: PaneView = {
    kind: 'new',
    agentId,
    projectPath: parent.projectPath,
    noProject: false,
    parentId: parent.id,
  }
  useViewStore.setState((s) => ({
    ...withLayout(s, showViewInLayout(s.layout, view), true),
    settings: { ...s.settings, open: false },
  }))
}

/** Puts New session in the main area as `openNewSession` does, leaving Settings as it is. */
export function placeNewSession(
  projectPath: string | null,
  agentId: AgentId | null,
  noProject = false,
): void {
  useViewStore.setState((s) =>
    withLayout(
      s,
      showViewInLayout(s.layout, newSessionView(s, projectPath, agentId, noProject)),
      true,
    ),
  )
}

/**
 * New session's view: a shown one keeps its agent, its No project and its project, unless given
 * one; anywhere else it takes the agent it was opened with. Its parent is not carried, since New
 * session opened plainly starts a session of its own.
 */
function newSessionView(
  s: ViewStore,
  projectPath: string | null,
  agentId: AgentId | null,
  noProject: boolean,
): PaneView {
  const shown = s.main.kind === 'new' ? s.main : null
  return {
    kind: 'new',
    agentId: shown ? shown.agentId : agentId,
    noProject: noProject || (projectPath === null && !!shown?.noProject),
    projectPath: projectPath ?? s.projectPath,
  }
}

/** Chooses where New session starts: a project, or null for No project. */
export function chooseNewSessionProject(projectPath: string | null): void {
  useViewStore.setState((s) => {
    const pane = newSessionPane(s.layout)
    if (!pane || pane.view.kind !== 'new') return s
    const view: PaneView = {
      ...pane.view,
      noProject: projectPath === null,
      projectPath: projectPath ?? pane.view.projectPath,
    }
    const focused = pane.id === s.layout.focus
    return {
      ...withLayout(s, setPaneViewInLayout(s.layout, pane.id, view)),
      // The image of the focused pane keeps the selected project, as the main view had it.
      ...(focused && sessionsShown(s.main) && s.main.kind === 'new'
        ? { projectPath: projectPath ?? s.projectPath }
        : {}),
    }
  })
}

/** Without a section, shows the one shown last; with one, switches to it even when already open. */
export function openSettings(section: SettingsSection | null = null): void {
  useViewStore.setState((s) => ({
    settings: section ? { open: true, section, item: null } : { ...s.settings, open: true },
  }))
}

/** Opens a section at one of its items' own pages, or at the list with null. */
export function openSettingsItem(section: SettingsSection, item: string | null): void {
  useViewStore.setState({ settings: { open: true, section, item } })
}

/** Opens Agents at one agent's page, or at the list with null. */
export function openAgentSettings(agent: AgentId | null): void {
  openSettingsItem('agents', agent)
}

/** What Esc does in Settings: from an item's page to its list, else out of Settings. */
export function settingsBack(): void {
  const { settings } = useViewStore.getState()
  if (settings.item) openSettingsItem(settings.section ?? 'agents', null)
  else closeSettings()
}

export function closeSettings(): void {
  useViewStore.setState((s) => ({ settings: { ...s.settings, open: false } }))
}

export function toggleSidebar(): void {
  useViewStore.setState((s) => ({ sidebarCollapsed: !s.sidebarCollapsed }))
}

/** Shows the shortcuts dialog, or closes it. */
export function showShortcuts(open: boolean): void {
  useViewStore.setState({ shortcutsOpen: open })
}

/** Closes the shortcuts dialog when open, and otherwise opens it unless another layer is open. */
export function toggleShortcuts(layerOpen: boolean): void {
  useViewStore.setState((s) =>
    s.shortcutsOpen ? { shortcutsOpen: false } : layerOpen ? s : { shortcutsOpen: true },
  )
}

/** Shows the pane in the side panel, or closes the panel when that pane is shown. */
export function toggleSidePane(projectPath: string, pane: SidePane, open?: boolean): void {
  useViewStore.setState((s) => {
    if (isSplit(s.layout)) {
      const shown = s.splitSidePane === pane
      if ((open ?? !shown) === shown) return s
      return { splitSidePane: shown ? null : pane, sidePaneMaximized: false }
    }
    const shown = s.sidePane[projectPath] === pane
    if ((open ?? !shown) === shown) return s
    const sidePane = { ...s.sidePane }
    if (shown) delete sidePane[projectPath]
    else sidePane[projectPath] = pane
    return { sidePane, sidePaneMaximized: false }
  })
}

/** Shows the artifact beside the thread, or closes the pane when it already shows it. */
export function toggleArtifactPane(projectPath: string, id: string, open?: boolean): void {
  useViewStore.setState((s) => {
    const before = isSplit(s.layout)
    const shown = before
      ? s.splitSidePane === 'artifact' && s.splitSideArtifact === id
      : s.sidePane[projectPath] === 'artifact' && s.sideArtifact[projectPath] === id
    if ((open ?? !shown) === shown) return s
    if (before) {
      return {
        splitSidePane: shown ? null : ('artifact' as const),
        splitSideArtifact: shown ? s.splitSideArtifact : id,
        sidePaneMaximized: false,
      }
    }
    const sidePane = { ...s.sidePane }
    if (shown) delete sidePane[projectPath]
    else sidePane[projectPath] = 'artifact'
    return {
      sidePane,
      sideArtifact: shown ? s.sideArtifact : { ...s.sideArtifact, [projectPath]: id },
      sidePaneMaximized: false,
    }
  })
}

/** The session, with the artifact beside its thread. */
export function openSessionWithArtifact(sessionId: string, projectPath: string, id: string): void {
  openSession(sessionId, projectPath)
  toggleArtifactPane(projectPath, id, true)
}

export function toggleTerminal(projectPath: string, open?: boolean): void {
  toggleSidePane(projectPath, 'terminal', open)
}

/** New session alone, which a launch opens with the setting off or nothing to restore. */
export function resetLayout(projectPath: string | null, agentId: AgentId | null): void {
  useViewStore.setState((s) => ({
    ...withLayout(s, createLayout({ kind: 'new', agentId, projectPath, noProject: false }), true),
    settings: { ...s.settings, open: false },
  }))
}

/** Puts a restored layout in the store, as the start of a split shows it. */
export function restoreLayout(layout: Layout): void {
  useViewStore.setState((s) => ({
    ...withLayout(s, layout, true),
    settings: { ...s.settings, open: false },
  }))
}
