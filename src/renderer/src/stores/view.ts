import { create } from 'zustand'
import type { AgentId, HarnessId } from '@shared/thread'
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
import type { RoutineExampleId } from '@renderer/features/routines/examples'
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
  // The Routines page, opened from the sidebar; with a null routine id, New routine, which an
  // example on the empty Routines page fills in.
  | { kind: 'routines' }
  | { kind: 'routine'; routineId: string | null; example?: RoutineExampleId }
  // The Artifacts page, opened from the sidebar; with `deleted`, its Recently deleted view.
  | { kind: 'artifacts'; deleted?: true }

// An artifact in the viewer, which Back leaves for what the main area showed before; `history`
// opens it with its version history.
export type MainView =
  PageView | { kind: 'artifact'; id: string; back: PageView; history?: boolean }

/** A page that shows alone in the main area while the split waits. */
type Page = Exclude<MainView, { kind: 'launch' | 'session' | 'new' }>

/** What a step of the history shows. */
export type HistoryView = MainView | PaneView

/** A page of Settings as a place of the history: a section's, or one of its items'. */
export interface SettingsPlace {
  kind: 'settings'
  section: SettingsSection
  item: string | null
}

/** What the window showed: Settings' page while it was open, else what the main area showed. */
export type HistoryPlace = MainView | SettingsPlace

/**
 * A step of the history: what the window showed before a change, as much as the change replaced:
 * the page shown alone, the views of the panes it changed, the pane in focus, and Settings when
 * the change opened, closed or moved it. `place` names what showed, for the history's lists, and
 * `at` is when it was left.
 */
export interface Step {
  page: Page | null
  panes: { id: string; view: PaneView }[]
  focus: string
  settings?: ViewStore['settings']
  place: HistoryPlace
  at: number
}

// The No project and Pinned groups' keys in `collapsedProjects`, which no folder's path can take.
export const NO_PROJECT_GROUP = 'no-project'
export const PINNED_GROUP = 'pinned'

/** This computer as the host the sidebar is narrowed to, which has no id of its own. */
export const THIS_COMPUTER = 'this-computer'

/** What the side panel shows; one pane at a time. An artifact's pane opens from the thread. */
export type SidePane = 'terminal' | 'files' | 'browser' | 'devices' | 'artifact'

// No session id takes this form, so New session's panel in a project has a key of its own.
const NEW_SESSION_PANEL = 'new-session:'

/** How many sessions' open panes a restart brings back; the most recently changed win. */
const REMEMBERED_PANELS = 200

export type SettingsSection =
  | 'general'
  | 'appearance'
  | 'agents'
  | 'harnesses'
  | 'terminal'
  | 'git'
  | 'notifications'
  | 'account'
  | 'usage'
  | 'mcp'
  | 'archived'
  | 'artifacts'
  | 'sharing'
  | 'remote'
  | 'hosts'
  | 'browser'
  | 'advanced'
  | 'about'

interface ViewStore {
  /** The regular New session draft's choices, kept while another view replaces its pane. */
  newSessionDraft: Extract<PaneView, { kind: 'new' }> | null
  projectPath: string | null
  main: MainView
  /** Columns of panes, and the pane in focus; the pane's view mirrors `main`. */
  layout: Layout
  /** The panes the split has room to show, as it measures its box. */
  visiblePanes: string[]
  /**
   * `section` is the page shown while open and the one to return to; null until one is chosen.
   * `item` is the page of one item of the section, such as an agent's or a server's, instead of
   * the list.
   */
  settings: { open: boolean; section: SettingsSection | null; item: string | null }
  /** The shortcuts dialog, over whatever the window shows. Not persisted. */
  shortcutsOpen: boolean
  /** Search, over whatever the window shows. Not persisted. */
  searchOpen: boolean
  /** Back and Forward through what the main area showed, nearest last. Not persisted. */
  history: { back: Step[]; forward: Step[] }
  sidebarCollapsed: boolean
  /** Groups the user collapsed, by path, `NO_PROJECT_GROUP` or `PINNED_GROUP`; open by default. */
  collapsedProjects: Record<string, true>
  /** The one host the sidebar lists, by id or `THIS_COMPUTER`; null lists every host. */
  hostFilter: string | null
  /** Parent sessions the user collapsed or expanded; others follow activity. */
  expandedParents: Record<string, boolean>
  /** Groups whose every row shows, past the first few; by the group's key. Not persisted. */
  allRowsShown: Record<string, true>
  /** Whether a session's sub-agents list and count the finished ones too, not only running ones. */
  showFinishedSubagents: boolean
  /**
   * The row being renamed and its group, whose end shows the rename keys. A row's own id, so one
   * still saving its name does not clear another's. Not persisted.
   */
  renamingIn: { scope: string; row: string } | null
  /**
   * The open side pane per panel, a session's by its id or New session's by `newSessionPanel`;
   * none when the panel is closed.
   */
  sidePane: Record<string, SidePane>
  /** The artifact each panel's artifact pane shows. */
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
  hostFilter?: string | null
  expandedParents: Record<string, boolean>
  showFinishedSubagents?: boolean
  /** Per panel; the per-project `sidePane` of earlier versions is not read. */
  sidePanes?: Record<string, SidePane>
  /** One pane per column, the pane in focus; read back as the split a restart opens. */
  layout?: unknown
  /** Under a new name since the page went flat: every run saved the old grouping as it was. */
  artifactsDisplay?: { group?: string; sort?: string }
}

const KEY = 'view:v1'
const saved = readJson<Partial<Persisted>>(KEY, {})

/** A layout stored by an earlier run, as it was written; `restoredLayout` reads it. */
export const savedLayout: unknown = saved.layout
/** The session an earlier run showed, for saves made before the split view. */
export const lastSessionId = saved.lastSessionId ?? null

export const useViewStore = create<ViewStore>()(() => ({
  newSessionDraft: null,
  projectPath: saved.projectPath ?? null,
  main: { kind: 'launch' },
  layout: readLayout(saved.layout) ?? createLayout(),
  visiblePanes: [],
  settings: { open: false, section: null, item: null },
  shortcutsOpen: false,
  searchOpen: false,
  history: { back: [], forward: [] },
  sidebarCollapsed: saved.sidebarCollapsed ?? false,
  collapsedProjects: saved.collapsedProjects ?? {},
  hostFilter: typeof saved.hostFilter === 'string' ? saved.hostFilter : null,
  expandedParents: saved.expandedParents ?? {},
  allRowsShown: {},
  showFinishedSubagents: saved.showFinishedSubagents === true,
  renamingIn: null,
  sidePane: saved.sidePanes ?? {},
  sideArtifact: {},
  sidePaneMaximized: false,
  artifactsView: {
    group: oneOf(GROUPINGS, saved.artifactsDisplay?.group, 'none'),
    sort: oneOf(SORTS, saved.artifactsDisplay?.sort, 'recent'),
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
      hostFilter: state.hostFilter,
      expandedParents: state.expandedParents,
      showFinishedSubagents: state.showFinishedSubagents,
      // An artifact's pane is not remembered: it opens from the thread, for the work at hand.
      sidePanes: Object.fromEntries(
        Object.entries(state.sidePane)
          .filter(([, pane]) => pane !== 'artifact')
          .slice(-REMEMBERED_PANELS),
      ),
      layout: saveLayout(state.layout),
      artifactsDisplay: state.artifactsView,
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
 * A store update after the layout changed: the main view of the focus while sessions show or when
 * asked to. The side panel follows by itself, since it is the focused pane's.
 */
function withLayout(s: ViewStore, layout: Layout, show = false): Partial<ViewStore> {
  const mirroring = show || sessionsShown(s.main)
  const changes: Partial<ViewStore> = { layout }
  const draft = newSessionPane(layout)?.view
  if (draft?.kind === 'new' && !draft.parentId) changes.newSessionDraft = draft
  if (mirroring) Object.assign(changes, mirror(s, layout))
  return changes
}

/** The key of New session's side panel in a project, which passes to the session it creates. */
export function newSessionPanel(projectPath: string): string {
  return `${NEW_SESSION_PANEL}${projectPath}`
}

/** The session a panel belongs to; null for New session's. */
export function panelSession(panel: string): string | null {
  return panel.startsWith(NEW_SESSION_PANEL) ? null : panel
}

/** Whose side panel a pane's view has: its session's, or New session's in its project. */
export function panelOf(view: PaneView): string | null {
  if (view.kind === 'session') return view.sessionId
  return view.projectPath ? newSessionPanel(view.projectPath) : null
}

/** The panel the side panel shows, the pane in focus's; null at New session with No project. */
export function shownPanel(state: ViewStore): string | null {
  return panelOf(focusedPane(state.layout).view)
}

export function shownSidePane(state: ViewStore): SidePane | undefined {
  const panel = shownPanel(state)
  return panel ? state.sidePane[panel] : undefined
}

export function shownSideArtifact(state: ViewStore): string | undefined {
  const panel = shownPanel(state)
  return panel ? state.sideArtifact[panel] : undefined
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
  const from = panelOf(pane.view)
  inPlace(() =>
    useViewStore.setState((s) => ({
      ...withLayout(
        s,
        setPaneViewInLayout(s.layout, paneId, { kind: 'session', sessionId, projectPath }),
        true,
      ),
      ...(from ? handPanel(s, from, sessionId) : {}),
    })),
  )
  return true
}

/** New session's side panel, given to the session it created and closed for the next one. */
function handPanel(
  s: ViewStore,
  from: string,
  to: string,
): Pick<ViewStore, 'sidePane' | 'sideArtifact'> {
  const sideArtifact = { ...s.sideArtifact }
  const artifact = sideArtifact[from]
  delete sideArtifact[from]
  if (artifact) sideArtifact[to] = artifact
  return {
    sidePane: withPane(withPane(s.sidePane, from, null), to, s.sidePane[from] ?? null),
    sideArtifact,
  }
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

/**
 * A routine's page, or New routine with a null id, filled in from `example` when given; with
 * `replace`, in place of the page shown, as New routine is by the routine it saved.
 */
export function openRoutine(
  routineId: string | null,
  { replace = false, example }: { replace?: boolean; example?: RoutineExampleId } = {},
): void {
  const open = () =>
    useViewStore.setState((s) => ({
      main: example ? { kind: 'routine', routineId, example } : { kind: 'routine', routineId },
      settings: { ...s.settings, open: false },
    }))
  if (replace) inPlace(open)
  else open()
}

/** The Artifacts page from the sidebar, with its whole list. */
export function openArtifacts(): void {
  useArtifactsStore.setState({ filter: '', kindFilter: null, projectFilter: null, opened: null })
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

/** The regular draft's choices, with an explicitly requested project taking precedence. */
function newSessionView(
  s: ViewStore,
  projectPath: string | null,
  agentId: AgentId | null,
  noProject: boolean,
): PaneView {
  const draft =
    s.main.kind === 'new' ? { ...s.main, projectPath: s.projectPath } : s.newSessionDraft
  return {
    kind: 'new',
    agentId: draft ? draft.agentId : agentId,
    noProject: noProject || (projectPath === null && !!draft?.noProject),
    projectPath: projectPath ?? draft?.projectPath ?? s.projectPath,
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

/** Opens Harnesses at one harness's page, or at the list with null. */
export function openHarnessSettings(harness: HarnessId | null): void {
  openSettingsItem('harnesses', harness)
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

/** Shows a group's every row, or its first few again. */
export function showAllRows(key: string, shown: boolean): void {
  useViewStore.setState((s) => {
    const allRowsShown = { ...s.allRowsShown }
    if (shown) allRowsShown[key] = true
    else delete allRowsShown[key]
    return { allRowsShown }
  })
}

export function setShowFinishedSubagents(shown: boolean): void {
  useViewStore.setState({ showFinishedSubagents: shown })
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

/** Shows Search, or closes it. */
export function showSearch(open: boolean): void {
  useViewStore.setState({ searchOpen: open })
}

/** Closes Search when open, and otherwise opens it unless another layer is open. */
export function toggleSearch(layerOpen: boolean): void {
  useViewStore.setState((s) =>
    s.searchOpen ? { searchOpen: false } : layerOpen ? s : { searchOpen: true },
  )
}

/** The panes with `panel` set to `pane`, or closed when null; the last changed comes last. */
function withPane(
  panes: Record<string, SidePane>,
  panel: string,
  pane: SidePane | null,
): Record<string, SidePane> {
  const next = { ...panes }
  delete next[panel]
  if (pane) next[panel] = pane
  return next
}

/** Shows the pane in a session's side panel, or closes the panel when that pane is shown. */
export function toggleSidePane(panel: string, pane: SidePane, open?: boolean): void {
  useViewStore.setState((s) => {
    const shown = s.sidePane[panel] === pane
    if ((open ?? !shown) === shown) return s
    return { sidePane: withPane(s.sidePane, panel, shown ? null : pane), sidePaneMaximized: false }
  })
}

/** Shows the pane in the side panel in view, when the pane in focus works in `projectPath`. */
export function showSidePane(projectPath: string, pane: SidePane): void {
  const view = focusedPane(useViewStore.getState().layout).view
  const panel = panelOf(view)
  if (panel && view.projectPath === projectPath) toggleSidePane(panel, pane, true)
}

/** Shows the artifact beside a session's thread, or closes the pane when it already shows it. */
export function toggleArtifactPane(panel: string, id: string, open?: boolean): void {
  useViewStore.setState((s) => {
    const shown = s.sidePane[panel] === 'artifact' && s.sideArtifact[panel] === id
    if ((open ?? !shown) === shown) return s
    return {
      sidePane: withPane(s.sidePane, panel, shown ? null : 'artifact'),
      sideArtifact: shown ? s.sideArtifact : { ...s.sideArtifact, [panel]: id },
      sidePaneMaximized: false,
    }
  })
}

/** The session, with the artifact beside its thread. */
export function openSessionWithArtifact(sessionId: string, projectPath: string, id: string): void {
  openSession(sessionId, projectPath)
  toggleArtifactPane(sessionId, id, true)
}

export function toggleTerminal(panel: string, open?: boolean): void {
  toggleSidePane(panel, 'terminal', open)
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

const HISTORY_LIMIT = 50

/** Whether a view of the history can still show, or went with what it showed. */
export type CanShow = (view: HistoryView) => boolean

type Direction = 'back' | 'forward'

// Off while a change must not record a step: a step itself, or a view shown in place of another.
let recording = true

/** A view's identity in the history: what it shows, not how. */
export function viewKey(view: HistoryView): string {
  switch (view.kind) {
    case 'session':
      return `session:${view.sessionId}`
    case 'new':
      return `new:${view.parentId ?? ''}`
    case 'routine':
      return `routine:${view.routineId ?? view.example ?? ''}`
    case 'artifacts':
      return view.deleted ? 'artifacts:deleted' : 'artifacts'
    case 'artifact':
      return `artifact:${view.id}`
    default:
      return view.kind
  }
}

function pageOf(main: MainView): Page | null {
  return main.kind === 'launch' || main.kind === 'session' || main.kind === 'new' ? null : main
}

const pageKey = (page: Page | null): string | null => (page ? viewKey(page) : null)

/** The page Settings shows, or null while it is closed; before a section is chosen, General. */
function settingsKey(settings: ViewStore['settings']): string | null {
  return settings.open ? `${settings.section ?? 'general'}/${settings.item ?? ''}` : null
}

/** What the window shows now, as the history names it. */
export function placeOf(s: Pick<ViewStore, 'main' | 'settings'>): HistoryPlace {
  const { open, section, item } = s.settings
  return open ? { kind: 'settings', section: section ?? 'general', item } : s.main
}

/** Shows a view in place of the one it replaces, which stays the same step. */
function inPlace(change: () => void): void {
  recording = false
  try {
    change()
  } finally {
    recording = true
  }
}

/**
 * The step back from `after` to `before`, left at `at`: the page and the views of the panes there
 * both times that changed, and Settings when its page changed. Null when nothing that shows
 * changed, as when only the focus moved.
 */
function stepBetween(before: ViewStore, after: ViewStore, at: number): Step | null {
  const page = pageOf(before.main)
  const panes = allPanes(before.layout).flatMap((pane) => {
    const now = findPane(after.layout, pane.id)
    return now && viewKey(now.view) !== viewKey(pane.view) ? [{ id: pane.id, view: pane.view }] : []
  })
  const settings = settingsKey(before.settings) !== settingsKey(after.settings)
  if (!panes.length && !settings && pageKey(page) === pageKey(pageOf(after.main))) return null
  return {
    page,
    panes,
    focus: before.layout.focus,
    ...(settings && { settings: before.settings }),
    place: placeOf(before),
    at,
  }
}

useViewStore.subscribe((state, previous) => {
  if (!recording) return
  if (
    state.main === previous.main &&
    state.layout === previous.layout &&
    state.settings === previous.settings
  ) {
    return
  }
  if (state.main.kind === 'launch' || previous.main.kind === 'launch') return
  // Under the same Settings page the main area changes unseen, in place of what it showed.
  const settings = settingsKey(state.settings)
  if (settings !== null && settings === settingsKey(previous.settings)) return
  const step = stepBetween(previous, state, Date.now())
  if (!step) return
  useViewStore.setState({
    history: { back: [...state.history.back, step].slice(-HISTORY_LIMIT), forward: [] },
  })
})

/**
 * What showing a step again changes: each pane it changed gets its view back and the focus, unless
 * the view shows in another pane by now, which takes the focus instead, or the pane has closed,
 * when the view goes to the pane in focus. A step that changed no pane gives back the focus.
 * Settings shows the page it showed then, and closes for a step taken with it closed.
 */
function applyStep(s: ViewStore, step: Step): Partial<ViewStore> {
  let layout = s.layout
  let focus = findPane(layout, step.focus) ? step.focus : layout.focus
  for (const { id, view } of step.panes) {
    // A session shows in one pane at most, and so does New session, whatever its parent.
    const shown = allPanes(layout).find(
      (pane) =>
        pane.id !== id &&
        (view.kind === 'new' ? pane.view.kind === 'new' : viewKey(pane.view) === viewKey(view)),
    )
    if (shown) {
      focus = shown.id
      continue
    }
    focus = findPane(layout, id) ? id : layout.focus
    layout = setPaneViewInLayout(layout, focus, view)
  }
  layout = focusPaneInLayout(layout, focus)
  const main = step.page ? { layout, main: step.page } : withLayout(s, layout, true)
  const settings = step.settings ?? (s.settings.open ? { ...s.settings, open: false } : s.settings)
  return { ...main, settings }
}

/** Whether a step can still show: its page and the views of its panes. */
export function stepShows(step: Step, canShow: CanShow): boolean {
  return (!step.page || canShow(step.page)) && step.panes.every((pane) => canShow(pane.view))
}

/**
 * The changes that show the nearest step of `direction` that can still show and move it to the
 * other list, inverted, with what showed until then left at `leftAt`; steps that can no longer
 * show are dropped on the way. Null when the list holds nothing to show or drop.
 */
function stepped(
  s: ViewStore,
  direction: Direction,
  canShow: CanShow,
  leftAt: number,
): { changes: Partial<ViewStore>; shown: Step | null } | null {
  const from = [...s.history[direction]]
  let step = from.pop()
  while (step && !stepShows(step, canShow)) step = from.pop()
  const other = s.history[direction === 'back' ? 'forward' : 'back']
  const history = (rest: Step[], others: Step[]) =>
    direction === 'back' ? { back: rest, forward: others } : { back: others, forward: rest }
  if (!step) {
    return from.length < s.history[direction].length
      ? { changes: { history: history(from, other) }, shown: null }
      : null
  }
  const changes = applyStep(s, step)
  const undo = stepBetween(s, { ...s, ...changes }, leftAt) ?? {
    page: pageOf(s.main),
    panes: [],
    focus: s.layout.focus,
    place: placeOf(s),
    at: leftAt,
  }
  return {
    changes: { ...changes, history: history(from, [...other, undo].slice(-HISTORY_LIMIT)) },
    shown: step,
  }
}

function move(direction: Direction, canShow: CanShow): void {
  const result = stepped(useViewStore.getState(), direction, canShow, Date.now())
  if (result) inPlace(() => useViewStore.setState(result.changes))
}

/**
 * Back to what the window showed before, a page of Settings or what the main area showed. Steps
 * whose view can no longer show are skipped.
 */
export function goBack(canShow: CanShow): void {
  move('back', canShow)
}

/** Forward again after going back. */
export function goForward(canShow: CanShow): void {
  move('forward', canShow)
}

/**
 * Goes back or forward to a step of that list in one change, as a browser's history does: the
 * places passed on the way move to the other list, each left when it was. False when the step is
 * no longer in the list or can no longer show.
 */
export function goTo(direction: Direction, target: Step, canShow: CanShow): boolean {
  let s = useViewStore.getState()
  if (!s.history[direction].includes(target) || !stepShows(target, canShow)) return false
  let changes: Partial<ViewStore> = {}
  let leftAt = Date.now()
  for (;;) {
    const result = stepped(s, direction, canShow, leftAt)
    if (!result) break
    s = { ...s, ...result.changes }
    changes = { ...changes, ...result.changes }
    if (result.shown === target) break
    if (result.shown) leftAt = result.shown.at
  }
  inPlace(() => useViewStore.setState(changes))
  return true
}

/**
 * A page's own Back to `view`: a step back when the step before shows that view, so Forward
 * returns. False otherwise, for the page to open the view itself.
 */
export function stepBackTo(view: HistoryView, canShow: CanShow): boolean {
  const s = useViewStore.getState()
  const step = s.history.back.at(-1)
  if (s.settings.open || !step || step.settings?.open || !stepShows(step, canShow)) return false
  if (viewKey(applyStep(s, step).main ?? s.main) !== viewKey(view)) return false
  move('back', canShow)
  return true
}
