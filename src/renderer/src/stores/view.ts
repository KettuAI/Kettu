import { create } from 'zustand'
import type { AgentId } from '@shared/thread'
import { markSwitchStart } from '@renderer/app/perf'
import {
  GROUPINGS,
  SORTS,
  type ArtifactGrouping,
  type ArtifactSort,
} from '@renderer/features/artifacts/model'
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
  artifactsView?: { group?: string; sort?: string }
  /** Read once from versions before the Files pane, when the side panel held only the terminal. */
  terminalOpen?: Record<string, boolean>
}

const KEY = 'view:v1'
const saved = readJson<Partial<Persisted>>(KEY, {})

export const useViewStore = create<ViewStore>()(() => ({
  projectPath: saved.projectPath ?? null,
  main: { kind: 'launch' },
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

export const lastSessionId = saved.lastSessionId ?? null

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
      artifactsView: state.artifactsView,
    }
    writeJson(KEY, persisted)
  }, 300)
})

export function openSession(sessionId: string, projectPath: string): void {
  const { main } = useViewStore.getState()
  if (main.kind !== 'session' || main.sessionId !== sessionId) markSwitchStart(sessionId)
  useViewStore.setState((s) => ({
    main: { kind: 'session', sessionId },
    projectPath,
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
    ...newSessionView(s, projectPath, agentId, noProject),
    settings: { ...s.settings, open: false },
  }))
}

/** New session for a sub-session of `parent`, in its project, with the agent the menu chose. */
export function openNewSubSession(
  parent: { id: string; projectPath: string },
  agentId: AgentId,
): void {
  useViewStore.setState((s) => ({
    main: { kind: 'new', agentId, noProject: false, parentId: parent.id },
    projectPath: parent.projectPath,
    settings: { ...s.settings, open: false },
  }))
}

/** Puts New session in the main area as `openNewSession` does, leaving Settings as it is. */
export function placeNewSession(
  projectPath: string | null,
  agentId: AgentId | null,
  noProject = false,
): void {
  useViewStore.setState((s) => newSessionView(s, projectPath, agentId, noProject))
}

function newSessionView(
  s: ViewStore,
  projectPath: string | null,
  agentId: AgentId | null,
  noProject: boolean,
): Pick<ViewStore, 'main' | 'projectPath'> {
  const shown = s.main.kind === 'new' ? s.main : null
  return {
    main: {
      kind: 'new',
      agentId: shown ? shown.agentId : agentId,
      noProject: noProject || (projectPath === null && !!shown?.noProject),
    },
    projectPath: projectPath ?? s.projectPath,
  }
}

/** Chooses where New session starts: a project, or null for No project. */
export function chooseNewSessionProject(projectPath: string | null): void {
  useViewStore.setState((s) =>
    s.main.kind !== 'new'
      ? s
      : {
          main: { ...s.main, noProject: projectPath === null },
          projectPath: projectPath ?? s.projectPath,
        },
  )
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

/** Shows the pane in the project's side panel, or closes the panel when that pane is shown. */
export function toggleSidePane(projectPath: string, pane: SidePane, open?: boolean): void {
  useViewStore.setState((s) => {
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
    const shown = s.sidePane[projectPath] === 'artifact' && s.sideArtifact[projectPath] === id
    if ((open ?? !shown) === shown) return s
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
