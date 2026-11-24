import { create } from 'zustand'
import type { Project } from '@shared/agent-host'
import { PLUGIN_ID } from '@shared/plugins'
import { PLUGIN_VIEW_ID, type PluginViewParams } from '@shared/plugin-views'
import type { AgentId, HarnessId } from '@shared/thread'
import { ARRANGEMENTS, type ArtifactArrange } from '@renderer/features/artifacts/model'
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
  resizeSplit,
  saveLayout,
  setPaneView as setPaneViewInLayout,
  showView as showViewInLayout,
  type Layout,
  type PaneView,
  type Place,
} from '@renderer/features/split/layout'
import { newSessionProject } from '@renderer/features/split/new-session-project'
import type { RoutineExampleId } from '@renderer/features/routines/examples'
import { NARROW_WINDOW, PHONE_WINDOW } from '@renderer/features/shell/narrow'
import { hostOfPath } from '@renderer/lib/host-paths'
import { readJson, writeJson } from '@renderer/lib/storage'
import { useArtifactsStore } from '@renderer/stores/artifacts'
import type { SettingsSection } from '@shared/settings-catalog'

type PageView =
  // At launch, until the last session or New session replaces it.
  | { kind: 'launch' }
  | { kind: 'session'; sessionId: string }
  // The New session screen; the session is created on the first send. With `noProject`, in a
  // scratch folder of its own rather than the selected project; with `hostId`, on the host chosen
  // before a project (null being this computer); with `parentId`, as a sub-session of that
  // session, in its project.
  | {
      kind: 'new'
      agentId: AgentId | null
      noProject: boolean
      hostId?: string | null
      parentId?: string
    }
  | { kind: 'usage' } // the usage page, opened from the sidebar
  // The Overview page, opened from the sidebar: every task and session that has something to say.
  | { kind: 'overview' }
  // The Routines page, opened from the sidebar; with a null routine id, New routine, which an
  // example on the empty Routines page fills in.
  | { kind: 'routines' }
  | { kind: 'routine'; routineId: string | null; example?: RoutineExampleId }
  // The Artifacts page, opened from the sidebar; with `deleted`, its Recently deleted view.
  | { kind: 'artifacts'; deleted?: true }
  // The Marketplace, opened from the sidebar: its directory on a tab, or with `item`, the listing
  // of the server with that id, a step of the history of its own.
  | { kind: 'marketplace'; item?: string; tab?: MarketplaceTab }
  // A task's page, opened from its row in the sidebar: its timeline, or with `flow`, its flowchart.
  | { kind: 'task'; taskId: string; flow?: true }

/** The Marketplace directory's tabs. */
export type MarketplaceTab =
  'all' | 'plugins' | 'skills' | 'mcp' | 'workflow' | 'installed' | 'published'

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

/**
 * What the side panel shows: the kind of its row's selected tab, or `surfaces`, the side panel's
 * list, while no tab is selected. A session has several terminals, browser pages and devices, and
 * one of each other kind.
 */
export type SidePane =
  | 'terminal'
  | 'files'
  | 'git'
  | 'browser'
  | 'devices'
  | 'surfaces'
  | 'computer'
  | 'requests'
  | 'file'
  | 'diff'
  | 'artifact'
  | 'plugin'
  | 'board'
  | 'sideChat'

/**
 * The kinds opened from a list, each a tab of its own: files, their changes, artifacts and the
 * panes of plugins.
 */
export type DocKind = 'file' | 'diff' | 'artifact' | 'plugin'

/** The kinds a session has one tab of. */
export type SingleTab = Exclude<SidePane, 'terminal' | 'browser' | 'devices' | 'surfaces' | DocKind>

/** What a file, diff or artifact tab shows; `id` tells it from the others of its kind. */
export type DocTarget =
  | {
      kind: 'file'
      /** The file's path: relative to the project, or absolute in the session agent's folder. */
      id: string
      /** For a file of that folder, the session it is read through. */
      agent?: { sessionId: string; agentId: AgentId }
    }
  | {
      kind: 'diff'
      id: string
      /** Relative to the repository root, as git names it. */
      path: string
      oldPath: string | null
      /** The commit, or null for the working tree against HEAD. */
      ref: string | null
      /** The same file as the project names it, or null when it lies outside the project. */
      projectFile: string | null
    }
  | { kind: 'artifact'; id: string }
  | {
      // A pane of a plugin, which draws one of its views; `id` joins the plugin's and the view's.
      kind: 'plugin'
      id: string
      pluginId: string
      viewId: string
      params?: PluginViewParams
    }

/** A tab of those kinds; the preview tab is the one the next single click replaces. */
export type DocTab = DocTarget & { preview: boolean }

const DOC_KINDS: readonly SidePane[] = ['file', 'diff', 'artifact', 'plugin']

export function isDocKind(pane: SidePane | null | undefined): pane is DocKind {
  return !!pane && DOC_KINDS.includes(pane)
}

/** A tab's key in the row: its kind, then its id within the kind. */
export function docKey(tab: Pick<DocTab, 'kind' | 'id'>): string {
  return `${tab.kind}:${tab.id}`
}

const SINGLE_TABS: readonly SidePane[] = [
  'files',
  'git',
  'board',
  'sideChat',
  'requests',
  'computer',
]

export function isSingleTab(pane: SidePane | null | undefined): pane is SingleTab {
  return !!pane && SINGLE_TABS.includes(pane)
}

// No session id takes this form, so New session's panel in a project has a key of its own.
const NEW_SESSION_PANEL = 'new-session:'

/** How many sessions' open panes a restart brings back; the most recently changed win. */
const REMEMBERED_PANELS = 200

export type { SettingsSection }

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
  settings: {
    open: boolean
    section: SettingsSection | null
    item: string | null
    /** A row to scroll to and flash once its page shows, as an agent's open_settings asks. */
    row?: string | null
  }
  /** The shortcuts dialog, over whatever the window shows. Not persisted. */
  shortcutsOpen: boolean
  /** Search, over whatever the window shows. Not persisted. */
  searchOpen: boolean
  /** Back and Forward through what the main area showed, nearest last. Not persisted. */
  history: { back: Step[]; forward: Step[] }
  sidebarCollapsed: boolean
  /** The sidebar as a drawer over a narrow window, apart from its collapsed state. Not persisted. */
  sidebarDrawer: boolean
  /**
   * The collapsed sidebar floating over a wide window while the pointer is on its toggle or on it;
   * `closing` while it fades out. Not persisted.
   */
  sidebarPeek: 'open' | 'closing' | null
  /** Groups the user collapsed, by path, `NO_PROJECT_GROUP` or `PINNED_GROUP`; open by default. */
  collapsedProjects: Record<string, true>
  /** The one host the sidebar lists, by id or `THIS_COMPUTER`; null lists every host. */
  hostFilter: string | null
  /**
   * The order the user dragged the sidebar's hosts into, by id or `THIS_COMPUTER`; empty until
   * then. It is this window's, since each computer connects to hosts of its own.
   */
  hostOrder: string[]
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
   * What each open side panel shows, a session's by its id or New session's by `newSessionPanel`;
   * none when the panel is closed.
   */
  sidePane: Record<string, SidePane>
  /** What each closed panel showed last, which its button opens again. */
  sideLast: Record<string, SidePane>
  /** Per panel, the one-per-session tabs its row holds, in the order they opened. */
  sideTabs: Record<string, SingleTab[]>
  /** Per panel, the keys of its row's tabs as last shown: as they opened, then as dragged. */
  sideOrder: Record<string, string[]>
  /** Per panel, its file, diff and artifact tabs; at most one of them is the preview tab. */
  sideDocs: Record<string, DocTab[]>
  /** Per panel, the key of the one of those tabs it shows, or showed last. */
  sideDoc: Record<string, string>
  /** A canvas page asked to be shown in a panel's artifact pane, until it is. Not persisted. */
  sideArtifactPage: Record<string, ArtifactPageRequest>
  sidePaneMaximized: boolean
  /** How the Artifacts page groups and sorts, for the whole app. */
  artifactsView: { arrange: ArtifactArrange }
}

interface Persisted {
  projectPath: string | null
  lastSessionId: string | null
  sidebarCollapsed: boolean
  collapsedProjects: Record<string, true>
  hostFilter?: string | null
  hostOrder?: string[]
  expandedParents: Record<string, boolean>
  showFinishedSubagents?: boolean
  /** Per panel; the per-project `sidePane` of earlier versions is not read. */
  sidePanes?: Record<string, SidePane>
  sideLast?: Record<string, SidePane>
  sideTabs?: Record<string, SingleTab[]>
  sideOrder?: Record<string, string[]>
  sideDocs?: Record<string, DocTab[]>
  sideDoc?: Record<string, string>
  /** Earlier versions had one artifact tab per panel, which showed this artifact. */
  sideArtifact?: Record<string, string>
  /** One pane per column, the pane in focus; read back as the split a restart opens. */
  layout?: unknown
  /** Under a new name since the page went flat: every run saved the old grouping as it was. */
  artifactsDisplay?: { arrange?: string; group?: string; sort?: string }
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
  sidebarDrawer: false,
  sidebarPeek: null,
  collapsedProjects: saved.collapsedProjects ?? {},
  hostFilter: typeof saved.hostFilter === 'string' ? saved.hostFilter : null,
  hostOrder: Array.isArray(saved.hostOrder)
    ? saved.hostOrder.filter((id): id is string => typeof id === 'string')
    : [],
  expandedParents: saved.expandedParents ?? {},
  allRowsShown: {},
  showFinishedSubagents: saved.showFinishedSubagents === true,
  renamingIn: null,
  ...savedPanels(saved),
  sideArtifactPage: {},
  sidePaneMaximized: false,
  artifactsView: { arrange: savedArrange(saved.artifactsDisplay) },
}))

type SidePanels = Pick<
  ViewStore,
  'sidePane' | 'sideLast' | 'sideTabs' | 'sideOrder' | 'sideDocs' | 'sideDoc'
>

/**
 * The side panels as saved. A save from before every pane was a tab has no row, so the pane it
 * showed becomes its row's tab; one from before a panel held several artifacts has its one
 * artifact tab as the first of them. A pane whose tab is gone is dropped.
 */
function savedPanels(from: Partial<Persisted>): SidePanels {
  const sideDocs: Record<string, DocTab[]> = {}
  for (const [panel, docs] of Object.entries(from.sideDocs ?? {})) {
    if (!Array.isArray(docs)) continue
    const kept = docs.filter(validPluginTab)
    if (kept.length > 0) sideDocs[panel] = kept
  }
  const sideDoc = { ...from.sideDoc }
  const sideOrder = { ...from.sideOrder }
  for (const [panel, id] of Object.entries(from.sideArtifact ?? {})) {
    if (sideDocs[panel] || !id) continue
    const tab: DocTab = { kind: 'artifact', id, preview: false }
    sideDocs[panel] = [tab]
    sideDoc[panel] = docKey(tab)
    // The one artifact tab had a key without an id.
    const order = sideOrder[panel]
    if (order) sideOrder[panel] = order.map((key) => (key === 'artifact:' ? docKey(tab) : key))
  }
  for (const panel of Object.keys(sideDoc)) {
    if (!sideDocs[panel]?.some((tab) => docKey(tab) === sideDoc[panel])) delete sideDoc[panel]
  }
  const held = (panel: string, pane: SidePane) =>
    !isDocKind(pane) || sideDoc[panel]?.startsWith(`${pane}:`)
  const panes = (given: Record<string, SidePane> | undefined) =>
    Object.fromEntries(Object.entries(given ?? {}).filter(([panel, pane]) => held(panel, pane)))
  const sidePane = panes(from.sidePanes)
  const sideLast = panes(from.sideLast)
  const sideTabs: Record<string, SingleTab[]> = {}
  for (const [panel, tabs] of Object.entries(from.sideTabs ?? {})) {
    const kept = tabs.filter((tab) => isSingleTab(tab))
    if (kept.length > 0) sideTabs[panel] = kept
  }
  for (const [panel, pane] of [...Object.entries(sideLast), ...Object.entries(sidePane)]) {
    if (isSingleTab(pane) && !sideTabs[panel]?.includes(pane)) {
      sideTabs[panel] = [...(sideTabs[panel] ?? []), pane]
    }
  }
  return { sidePane, sideLast, sideTabs, sideOrder, sideDocs, sideDoc }
}

/** Whether a saved tab can be one: any tab but a plugin's, which must name a plugin and its view. */
function validPluginTab(tab: DocTab): boolean {
  if (tab.kind !== 'plugin') return true
  return (
    PLUGIN_ID.test(String(tab.pluginId)) &&
    PLUGIN_VIEW_ID.test(String(tab.viewId)) &&
    tab.id === pluginPaneId(tab.pluginId, tab.viewId)
  )
}

/** The arrangement saved, or the one an earlier run's grouping and sort come closest to. */
function savedArrange(saved: Persisted['artifactsDisplay']): ArtifactArrange {
  if (ARRANGEMENTS.includes(saved?.arrange as ArtifactArrange)) {
    return saved!.arrange as ArtifactArrange
  }
  if (saved?.group === 'project-session') return 'project'
  return saved?.sort === 'name' ? 'name' : 'recent'
}

function remembered<T>(panels: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(panels).slice(-REMEMBERED_PANELS))
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
      hostOrder: state.hostOrder,
      expandedParents: state.expandedParents,
      showFinishedSubagents: state.showFinishedSubagents,
      sidePanes: remembered(state.sidePane),
      sideLast: remembered(state.sideLast),
      sideTabs: remembered(state.sideTabs),
      sideOrder: remembered(state.sideOrder),
      sideDocs: remembered(state.sideDocs),
      sideDoc: remembered(state.sideDoc),
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
      ...(view.hostId !== undefined ? { hostId: view.hostId } : {}),
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

/** The file, diff or artifact tab the panel shows; none while it shows another kind. */
export function shownDoc(state: ViewStore, panel: string | null): DocTab | undefined {
  if (!panel || !isDocKind(state.sidePane[panel])) return undefined
  const key = state.sideDoc[panel]
  return state.sideDocs[panel]?.find((tab) => docKey(tab) === key)
}

/** Whether the panel shows this artifact's tab. */
export function artifactShown(state: ViewStore, panel: string, id: string): boolean {
  return state.sidePane[panel] === 'artifact' && state.sideDoc[panel] === `artifact:${id}`
}

/** The sessions the layout holds, folded panes included. */
export function layoutSessions(layout: Layout): string[] {
  return allPanes(layout).flatMap((pane) =>
    pane.view.kind === 'session' ? [pane.view.sessionId] : [],
  )
}

/**
 * The projects the panes in view work in, joined, for their git status: a New session pane's
 * included, which falls back to the selected or first project when it has none of its own.
 */
export function shownProjects(state: ViewStore, projects: readonly Project[]): string {
  const panes = new Set(state.visiblePanes.length ? state.visiblePanes : paneOrder(state.layout))
  const paths = allPanes(state.layout).flatMap((pane) => {
    if (!panes.has(pane.id)) return []
    const { view } = pane
    const fallback =
      view.kind === 'new' ? newSessionProject(view, state.projectPath, projects)?.path : undefined
    return [view.projectPath, fallback].filter((path): path is string => !!path)
  })
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
 * Shows the pane at that place in the split, counted in tree order; false past the last pane,
 * which the key leaves alone.
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

/** Keeps the shares a resize of one of the split's groups left, in that split's own shares. */
export function setSplitShares(splitId: string, sizes: Record<string, number>): void {
  useViewStore.setState((s) => ({ layout: resizeSplit(s.layout, splitId, sizes) }))
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
function handPanel(s: ViewStore, from: string, to: string): SidePanels {
  return {
    sidePane: handed(s.sidePane, from, to),
    sideLast: handed(s.sideLast, from, to),
    sideTabs: handed(s.sideTabs, from, to),
    sideOrder: handed(s.sideOrder, from, to),
    sideDocs: handed(s.sideDocs, from, to),
    sideDoc: handed(s.sideDoc, from, to),
  }
}

/** The panels with what `from` had under `to`; the last changed comes last. */
function handed<T>(panels: Record<string, T>, from: string, to: string): Record<string, T> {
  const next = { ...panels }
  const value = next[from]
  delete next[from]
  delete next[to]
  if (value !== undefined) next[to] = value
  return next
}

export function openOverview(): void {
  useViewStore.setState((s) => ({
    main: { kind: 'overview' },
    settings: { ...s.settings, open: false },
  }))
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

/**
 * The Marketplace: its directory on `tab`, All unless given, or the listing of `item`. A tab
 * changes the page shown in place, so Back leaves the Marketplace rather than its tabs.
 */
export function openMarketplace({ item, tab }: { item?: string; tab?: MarketplaceTab } = {}): void {
  useViewStore.setState((s) => ({
    main: marketplaceView(item, tab),
    settings: { ...s.settings, open: false },
  }))
}

/** Shows another tab of the Marketplace's directory in place, as the same step of the history. */
export function setMarketplaceTab(tab: MarketplaceTab): void {
  useViewStore.setState((s) =>
    s.main.kind === 'marketplace' && !s.main.item ? { main: marketplaceView(undefined, tab) } : s,
  )
}

function marketplaceView(item: string | undefined, tab: MarketplaceTab | undefined): MainView {
  return {
    kind: 'marketplace',
    ...(item ? { item } : {}),
    ...(tab && tab !== 'all' ? { tab } : {}),
  }
}

/** A task's page, on its timeline unless `flow` asks for its flowchart. */
export function openTask(taskId: string, { flow = false }: { flow?: boolean } = {}): void {
  useViewStore.setState((s) => ({
    main: flow ? { kind: 'task', taskId, flow: true } : { kind: 'task', taskId },
    settings: { ...s.settings, open: false },
  }))
}

/** Switches the task's page between its timeline and its flowchart, as the same step. */
export function setTaskFlow(taskId: string, flow: boolean): void {
  useViewStore.setState((s) =>
    s.main.kind === 'task' && s.main.taskId === taskId
      ? { main: flow ? { kind: 'task', taskId, flow: true } : { kind: 'task', taskId } }
      : s,
  )
}

/** The side panel of a task's page, where the documents its steps hand in open. */
export function taskPanel(taskId: string): string {
  return `task:${taskId}`
}

/** The Artifacts page from the sidebar, with its whole list. */
export function openArtifacts(): void {
  useArtifactsStore.setState({
    filter: '',
    kindFilter: null,
    projectFilter: [],
    statusFilter: [],
    onlyChanged: false,
    opened: null,
  })
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

/** The page requests of the viewer in the main area, beside each panel's. */
export const MAIN_ARTIFACT_PANEL = 'main'

/**
 * Shows an artifact in the viewer, in place of what the main area shows; `page`, a canvas page's
 * id, or `slide`, a deck's slide from 1, is where it opens.
 */
export function openArtifact(
  id: string,
  { history = false, page, slide }: { history?: boolean; page?: string; slide?: number } = {},
): void {
  useViewStore.setState((s) => {
    const sideArtifactPage = { ...s.sideArtifactPage }
    if (page)
      sideArtifactPage[MAIN_ARTIFACT_PANEL] = { artifactId: id, pageId: page, seq: ++pageRequests }
    else if (slide)
      sideArtifactPage[MAIN_ARTIFACT_PANEL] = {
        artifactId: id,
        pageId: '',
        slide,
        seq: ++pageRequests,
      }
    else delete sideArtifactPage[MAIN_ARTIFACT_PANEL]
    return {
      main: {
        kind: 'artifact',
        id,
        back: s.main.kind === 'artifact' ? s.main.back : s.main,
        ...(history && { history }),
      },
      settings: { ...s.settings, open: false },
      sideArtifactPage,
    }
  })
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
  const kept = noProject || (projectPath === null && !!draft?.noProject)
  // An explicitly requested project decides the host; otherwise the draft's choice stays.
  const hostId = projectPath === null && !kept ? draft?.hostId : undefined
  return {
    kind: 'new',
    agentId: draft ? draft.agentId : agentId,
    noProject: kept,
    projectPath: projectPath ?? draft?.projectPath ?? s.projectPath,
    ...(hostId !== undefined ? { hostId } : {}),
  }
}

function chooseNewSession(change: {
  hostId: string | null
  noProject: boolean
  projectPath: string | null
}): void {
  useViewStore.setState((s) => {
    const pane = newSessionPane(s.layout)
    if (!pane || pane.view.kind !== 'new') return s
    const view: PaneView = { ...pane.view, ...change }
    const focused = pane.id === s.layout.focus
    return {
      ...withLayout(s, setPaneViewInLayout(s.layout, pane.id, view)),
      // The image of the focused pane keeps the selected project, as the main view had it.
      ...(focused && sessionsShown(s.main) && s.main.kind === 'new'
        ? { projectPath: change.projectPath ?? s.projectPath }
        : {}),
    }
  })
}

/** Chooses where New session starts: a project, or null for No project, on this computer. */
export function chooseNewSessionProject(projectPath: string | null): void {
  const pane = newSessionPane(useViewStore.getState().layout)
  chooseNewSession({
    hostId: projectPath === null ? null : hostOfPath(projectPath),
    noProject: projectPath === null,
    projectPath: projectPath ?? (pane?.view.kind === 'new' ? pane.view.projectPath : null),
  })
}

/** Chooses the host New session starts on, with the project it starts in there, if it has one. */
export function chooseNewSessionHost(hostId: string | null, projectPath: string | null): void {
  chooseNewSession({ hostId, noProject: false, projectPath })
}

/** Without a section, shows the one shown last; with one, switches to it even when already open. */
export function openSettings(section: SettingsSection | null = null): void {
  // A phone shows one screen at a time, so Settings opens at its list of sections there.
  const list = window.matchMedia(PHONE_WINDOW).matches
  useViewStore.setState((s) => ({
    settings: section
      ? { open: true, section, item: null }
      : list
        ? { open: true, section: null, item: null }
        : { ...s.settings, open: true },
  }))
}

/** Opens a section at one of its items' own pages, or at the list with null. */
export function openSettingsItem(section: SettingsSection, item: string | null): void {
  useViewStore.setState({ settings: { open: true, section, item } })
}

/** Opens a section, or one of its items' pages, at a row, which flashes as a search result does. */
export function openSettingsRow(section: SettingsSection, item: string | null, row: string): void {
  useViewStore.setState({ settings: { open: true, section, item, row } })
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
  else if (settings.section && window.matchMedia(PHONE_WINDOW).matches) openSettings()
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
  // A narrow window's sidebar is a drawer, which leaves the wide window's collapsed state alone.
  if (window.matchMedia(NARROW_WINDOW).matches)
    useViewStore.setState((s) => ({ sidebarDrawer: !s.sidebarDrawer }))
  else useViewStore.setState((s) => ({ sidebarCollapsed: !s.sidebarCollapsed }))
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

/** The panel's one-per-session tabs with `tab` among them. */
function withTab(
  tabs: Record<string, SingleTab[]>,
  panel: string,
  pane: SidePane,
): Record<string, SingleTab[]> {
  if (!isSingleTab(pane) || tabs[panel]?.includes(pane)) return tabs
  return { ...tabs, [panel]: [...(tabs[panel] ?? []), pane] }
}

/** The state with the panel closed, remembering what it showed for its button. */
function closedPanel(
  s: ViewStore,
  panel: string,
): Pick<ViewStore, 'sidePane' | 'sideLast' | 'sidePaneMaximized'> {
  const shown = s.sidePane[panel]
  return {
    sidePane: withPane(s.sidePane, panel, null),
    sideLast: shown ? withPane(s.sideLast, panel, shown) : s.sideLast,
    sidePaneMaximized: false,
  }
}

/**
 * Shows a kind in a session's side panel, a one-per-session kind joining the row as its tab, or
 * closes the panel when it already shows that kind. The row and its tabs stay when it closes.
 */
export function toggleSidePane(panel: string, pane: SidePane, open?: boolean): void {
  useViewStore.setState((s) => {
    const shown = s.sidePane[panel] === pane
    if ((open ?? !shown) === shown) return s
    if (shown) return closedPanel(s, panel)
    return {
      sidePane: withPane(s.sidePane, panel, pane),
      sideTabs: withTab(s.sideTabs, panel, pane),
      // Changing tabs keeps a maximized panel as it is; opening it starts beside the thread.
      sidePaneMaximized: s.sidePane[panel] ? s.sidePaneMaximized : false,
    }
  })
}

/** Folds a session's side panel away; its button opens it again on what it showed. */
export function closeSidePanel(panel: string): void {
  useViewStore.setState((s) => (s.sidePane[panel] ? closedPanel(s, panel) : s))
}

/** Adds a one-per-session tab to a panel's row without showing it. */
export function addSideTab(panel: string, tab: SingleTab): void {
  useViewStore.setState((s) => {
    const sideTabs = withTab(s.sideTabs, panel, tab)
    return sideTabs === s.sideTabs ? s : { sideTabs }
  })
}

/** Takes a one-per-session tab off a panel's row; what it showed stays as it is. */
export function removeSideTab(panel: string, tab: SingleTab): void {
  useViewStore.setState((s) => {
    const tabs = s.sideTabs[panel]
    if (!tabs?.includes(tab)) return s
    const sideTabs = { ...s.sideTabs }
    const kept = tabs.filter((other) => other !== tab)
    if (kept.length > 0) sideTabs[panel] = kept
    else delete sideTabs[panel]
    return { sideTabs }
  })
}

/** Selects a session's board tab, or closes the panel when it shows the board. */
export function toggleBoard(sessionId: string, open?: boolean): void {
  toggleSidePane(sessionId, 'board', open)
}

/** Selects a session's side chat tab, or closes the panel when it shows the side chat. */
export function toggleSideChat(sessionId: string, open?: boolean): void {
  toggleSidePane(sessionId, 'sideChat', open)
}

/** Shows the pane in the side panel in view, when the pane in focus works in `projectPath`. */
export function showSidePane(projectPath: string, pane: SidePane): void {
  const view = focusedPane(useViewStore.getState().layout).view
  const panel = panelOf(view)
  if (panel && view.projectPath === projectPath) toggleSidePane(panel, pane, true)
}

/** A canvas page the artifact pane brings into view once it has laid it out. */
export interface ArtifactPageRequest {
  artifactId: string
  /** A canvas page's id; empty for a deck's slide. */
  pageId: string
  /** A deck's slide, from 1. */
  slide?: number
  /** Tells a repeated request for the same page from one already handled. */
  seq: number
}

let pageRequests = 0

// Per panel, the key of the tab its row shows as selected, which a tab opened from a list in the
// panel goes after. The row says, since a terminal, page or device is chosen in its own store.
const selectedKeys = new Map<string, string>()

/** The row's word on which of its tabs is selected. */
export function noteSelectedTab(panel: string, key: string | null): void {
  if (key) selectedKeys.set(panel, key)
  else selectedKeys.delete(panel)
}

export interface OpenDocOptions {
  /** In the preview tab, which the next such open replaces; an open tab stays as it is. */
  preview?: boolean
  /** Opened from a list in the panel, so it goes right after the selected tab instead of last. */
  fromPanel?: boolean
}

function withDocs(
  all: Record<string, DocTab[]>,
  panel: string,
  docs: DocTab[],
): Record<string, DocTab[]> {
  const next = { ...all }
  delete next[panel]
  if (docs.length > 0) next[panel] = docs
  return next
}

/**
 * Shows a file, a diff or an artifact in a tab of the panel's row: its own when it has one, the
 * preview tab's place for a preview, else a new tab. Returns the preview tab it replaced.
 */
export function openDoc(
  panel: string,
  target: DocTarget,
  { preview = false, fromPanel = false }: OpenDocOptions = {},
): DocTab | null {
  const key = docKey(target)
  let replaced: DocTab | null = null
  useViewStore.setState((s) => {
    const docs = s.sideDocs[panel] ?? []
    const order = s.sideOrder[panel] ?? []
    const shown = {
      sidePane: withPane(s.sidePane, panel, target.kind),
      sideDoc: { ...s.sideDoc, [panel]: key },
      // Changing tabs keeps a maximized panel as it is; opening it starts beside the thread.
      sidePaneMaximized: s.sidePane[panel] ? s.sidePaneMaximized : false,
    }
    const open = docs.find((tab) => docKey(tab) === key)
    if (open) {
      if (!open.preview || preview) return shown
      const kept = docs.map((tab) => (tab === open ? { ...tab, preview: false } : tab))
      return { ...shown, sideDocs: withDocs(s.sideDocs, panel, kept) }
    }
    const added: DocTab = { ...target, preview }
    const at = preview ? docs.findIndex((tab) => tab.preview) : -1
    if (at >= 0) {
      replaced = docs[at]!
      const from = docKey(replaced)
      return {
        ...shown,
        sideDocs: withDocs(s.sideDocs, panel, docs.with(at, added)),
        sideOrder: {
          ...s.sideOrder,
          [panel]: order.map((other) => (other === from ? key : other)),
        },
      }
    }
    const after = fromPanel ? order.indexOf(selectedKeys.get(panel) ?? '') : -1
    return {
      ...shown,
      sideDocs: withDocs(s.sideDocs, panel, [...docs, added]),
      // A key the row does not have yet goes last by itself.
      ...(after >= 0 && {
        sideOrder: { ...s.sideOrder, [panel]: order.toSpliced(after + 1, 0, key) },
      }),
    }
  })
  return replaced
}

/** Shows one of the panel's file, diff or artifact tabs. */
export function selectDoc(panel: string, key: string): void {
  useViewStore.setState((s) => {
    const tab = s.sideDocs[panel]?.find((other) => docKey(other) === key)
    if (!tab || (s.sidePane[panel] === tab.kind && s.sideDoc[panel] === key)) return s
    return {
      sidePane: withPane(s.sidePane, panel, tab.kind),
      sideDoc: { ...s.sideDoc, [panel]: key },
      sidePaneMaximized: s.sidePane[panel] ? s.sidePaneMaximized : false,
    }
  })
}

/** Changes the panel's file, diff and artifact tabs, such as a file's path once it moved. */
export function changeDocs(panel: string, change: (tab: DocTab) => DocTab): void {
  useViewStore.setState((s) => {
    const docs = s.sideDocs[panel]
    if (!docs) return s
    const next = docs.map(change)
    if (next.every((tab, index) => tab === docs[index])) return s
    const renamed = new Map(docs.map((tab, index) => [docKey(tab), docKey(next[index]!)]))
    const shown = s.sideDoc[panel]
    return {
      sideDocs: withDocs(s.sideDocs, panel, next),
      ...(s.sideOrder[panel] && {
        sideOrder: {
          ...s.sideOrder,
          [panel]: s.sideOrder[panel].map((key) => renamed.get(key) ?? key),
        },
      }),
      ...(shown && { sideDoc: { ...s.sideDoc, [panel]: renamed.get(shown) ?? shown } }),
    }
  })
}

/** Makes the preview tab a regular one, which the next single click leaves alone. */
export function keepDoc(panel: string, key: string): void {
  changeDocs(panel, (tab) =>
    tab.preview && docKey(tab) === key ? { ...tab, preview: false } : tab,
  )
}

/**
 * Takes a file, diff or artifact tab off the panel's row. A panel that still shows it shows the
 * tab after it in the row, else the one before, else the side panel's list.
 */
export function closeDoc(panel: string, key: string): void {
  useViewStore.setState((s) => {
    const docs = s.sideDocs[panel]
    const tab = docs?.find((other) => docKey(other) === key)
    if (!docs || !tab) return s
    const left = docs.filter((other) => other !== tab)
    const sideDocs = withDocs(s.sideDocs, panel, left)
    if (s.sideDoc[panel] !== key) return { sideDocs }
    const sideDoc = { ...s.sideDoc }
    delete sideDoc[panel]
    if (s.sidePane[panel] !== tab.kind) {
      const sideLast = { ...s.sideLast }
      if (sideLast[panel] === tab.kind) delete sideLast[panel]
      return { sideDocs, sideDoc, sideLast }
    }
    // The order may still name tabs closed a moment ago; those are no neighbour.
    const open = new Set(docs.map(docKey))
    const order = (s.sideOrder[panel] ?? []).filter(
      (other) =>
        other === key ||
        !isDocKind(other.slice(0, other.indexOf(':')) as SidePane) ||
        open.has(other),
    )
    const index = order.indexOf(key)
    const next = index < 0 ? undefined : (order[index + 1] ?? order[index - 1])
    const pane = (next?.slice(0, next.indexOf(':')) ?? 'surfaces') as SidePane
    if (next && isDocKind(pane)) sideDoc[panel] = next
    return { sideDocs, sideDoc, sidePane: withPane(s.sidePane, panel, pane) }
  })
}

/** A plugin pane's id in the tab row: one tab per plugin and view. */
export function pluginPaneId(pluginId: string, viewId: string): string {
  return `${pluginId}/${viewId}`
}

/**
 * Shows a pane of a plugin in a tab of the panel's row: its own when it has one, else a new tab.
 * Opened with other `params` than the tab holds, the tab starts over with them.
 */
export function openPluginPane(
  panel: string,
  pane: { pluginId: string; viewId: string; params?: PluginViewParams },
  options?: Pick<OpenDocOptions, 'fromPanel'>,
): void {
  const id = pluginPaneId(pane.pluginId, pane.viewId)
  const params = pane.params && Object.keys(pane.params).length > 0 ? pane.params : undefined
  openDoc(
    panel,
    {
      kind: 'plugin',
      id,
      pluginId: pane.pluginId,
      viewId: pane.viewId,
      ...(params && { params }),
    },
    { ...options, preview: false },
  )
  changeDocs(panel, (tab) => {
    if (tab.kind !== 'plugin' || tab.id !== id) return tab
    if (JSON.stringify(tab.params ?? null) === JSON.stringify(params ?? null)) return tab
    return {
      kind: 'plugin',
      id,
      pluginId: tab.pluginId,
      viewId: tab.viewId,
      preview: false,
      ...(params && { params }),
    }
  })
}

/** Shows the artifact in a tab of a session's side panel. */
export function openArtifactTab(panel: string, id: string, options?: OpenDocOptions): void {
  openDoc(panel, { kind: 'artifact', id }, options)
}

/** Shows a canvas artifact beside a session's thread with one of its pages in view. */
export function showArtifactPage(
  panel: string,
  id: string,
  pageId: string,
  options: OpenDocOptions = { preview: true },
): void {
  openArtifactTab(panel, id, options)
  useViewStore.setState((s) => ({
    sideArtifactPage: {
      ...s.sideArtifactPage,
      [panel]: { artifactId: id, pageId, seq: ++pageRequests },
    },
  }))
}

/** The pane showed the page it was asked for. */
export function artifactPageShown(panel: string, seq: number): void {
  useViewStore.setState((s) => {
    if (s.sideArtifactPage[panel]?.seq !== seq) return s
    const sideArtifactPage = { ...s.sideArtifactPage }
    delete sideArtifactPage[panel]
    return { sideArtifactPage }
  })
}

/** The session, with the artifact beside its thread. */
export function openSessionWithArtifact(sessionId: string, projectPath: string, id: string): void {
  openSession(sessionId, projectPath)
  openArtifactTab(sessionId, id)
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

// The views the last Back or Forward showed again, by `viewKey`, until the history records a step.
let returned = new Set<string>()

/**
 * Whether the last Back or Forward showed this view again, rather than a change opening it, so it
 * can return to where the user was in it.
 */
export function returnedTo(view: HistoryView): boolean {
  return returned.has(viewKey(view))
}

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
    case 'marketplace':
      return view.item ? `marketplace:${view.item}` : 'marketplace'
    case 'artifact':
      return `artifact:${view.id}`
    case 'task':
      return `task:${view.taskId}`
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
  returned = new Set()
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
  const s = useViewStore.getState()
  const result = stepped(s, direction, canShow, Date.now())
  if (result) showAgain(s, result.changes, result.shown !== null)
}

/** Applies the changes of Back or Forward; with `shown`, what they show counts as returned to. */
function showAgain(s: ViewStore, changes: Partial<ViewStore>, shown: boolean): void {
  if (shown) {
    const next = { ...s, ...changes }
    const page = pageOf(next.main)
    returned = new Set(page ? [viewKey(page)] : allPanes(next.layout).map((p) => viewKey(p.view)))
  }
  inPlace(() => useViewStore.setState(changes))
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
  const before = useViewStore.getState()
  if (!before.history[direction].includes(target) || !stepShows(target, canShow)) return false
  let s = before
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
  showAgain(before, changes, true)
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
