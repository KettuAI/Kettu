import { create } from 'zustand'
import type { AgentId } from '@shared/thread'
import { markSwitchStart } from '@renderer/app/perf'
import { readJson, writeJson } from '@renderer/lib/storage'

export type MainView =
  // At launch, until the last session or New session replaces it; Welcome while there are no
  // projects.
  | { kind: 'welcome' }
  | { kind: 'session'; sessionId: string }
  // The New session screen; the session is created on the first send. With `noProject`, in a
  // scratch folder of its own rather than the selected project.
  | { kind: 'new'; agentId: AgentId | null; noProject: boolean }
  | { kind: 'usage' } // the usage page, opened from the sidebar

// The No project group's key in `collapsedProjects`, which no folder's path can take.
export const NO_PROJECT_GROUP = 'no-project'

/** What the side panel shows; one pane at a time. */
export type SidePane = 'terminal' | 'files'

export type SettingsSection =
  | 'general'
  | 'appearance'
  | 'agents'
  | 'terminal'
  | 'git'
  | 'notifications'
  | 'usage'
  | 'shortcuts'
  | 'advanced'
  | 'about'

interface ViewStore {
  projectPath: string | null
  main: MainView
  /**
   * `section` is the page shown while open and the one to return to; null until one is chosen.
   * `agent` is the agent whose own page Agents shows instead of the list.
   */
  settings: { open: boolean; section: SettingsSection | null; agent: AgentId | null }
  sidebarCollapsed: boolean
  /** Project groups the user collapsed, by path or `NO_PROJECT_GROUP`; open by default. */
  collapsedProjects: Record<string, true>
  /** Parent sessions the user collapsed or expanded; others follow activity. */
  expandedParents: Record<string, boolean>
  /** The open side pane per project; none when the panel is closed. */
  sidePane: Record<string, SidePane>
  sidePaneMaximized: boolean
}

interface Persisted {
  projectPath: string | null
  lastSessionId: string | null
  sidebarCollapsed: boolean
  collapsedProjects: Record<string, true>
  expandedParents: Record<string, boolean>
  sidePane: Record<string, SidePane>
  /** Read once from versions before the Files pane, when the side panel held only the terminal. */
  terminalOpen?: Record<string, boolean>
}

const KEY = 'view:v1'
const saved = readJson<Partial<Persisted>>(KEY, {})

export const useViewStore = create<ViewStore>()(() => ({
  projectPath: saved.projectPath ?? null,
  main: { kind: 'welcome' },
  settings: { open: false, section: null, agent: null },
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
  sidePaneMaximized: false,
}))

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
      sidePane: state.sidePane,
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
    settings: section ? { open: true, section, agent: null } : { ...s.settings, open: true },
  }))
}

/** Opens Agents at one agent's page, or at the list with null. */
export function openAgentSettings(agent: AgentId | null): void {
  useViewStore.setState({ settings: { open: true, section: 'agents', agent } })
}

/** What Esc does in Settings: from an agent's page to the list, else out of Settings. */
export function settingsBack(): void {
  const { settings } = useViewStore.getState()
  if (settings.agent) openAgentSettings(null)
  else closeSettings()
}

export function closeSettings(): void {
  useViewStore.setState((s) => ({ settings: { ...s.settings, open: false } }))
}

export function toggleSidebar(): void {
  useViewStore.setState((s) => ({ sidebarCollapsed: !s.sidebarCollapsed }))
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

export function toggleTerminal(projectPath: string, open?: boolean): void {
  toggleSidePane(projectPath, 'terminal', open)
}
