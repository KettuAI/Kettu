import { create } from 'zustand'
import type { AgentId } from '@shared/thread'
import { markSwitchStart } from '@renderer/app/perf'
import { readJson, writeJson } from '@renderer/lib/storage'

export type MainView =
  | { kind: 'home' } // Welcome without projects, else the selected project's home
  | { kind: 'session'; sessionId: string }
  // The New session screen; the session is created on the first send.
  | { kind: 'new'; agentId: AgentId | null }

/** What the side panel shows; one pane at a time. */
export type SidePane = 'terminal' | 'files'

export type SettingsSection =
  | 'general'
  | 'appearance'
  | 'agents'
  | 'terminal'
  | 'git'
  | 'notifications'
  | 'shortcuts'
  | 'advanced'
  | 'about'

interface ViewStore {
  projectPath: string | null
  main: MainView
  /** `section` is the page shown while open and the one to return to; null until one is chosen. */
  settings: { open: boolean; section: SettingsSection | null }
  sidebarCollapsed: boolean
  /** Project groups the user collapsed; open by default. */
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
  main: { kind: 'home' },
  settings: { open: false, section: null },
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

export function openProjectHome(projectPath: string | null): void {
  useViewStore.setState((s) => ({
    main: { kind: 'home' },
    projectPath,
    settings: { ...s.settings, open: false },
  }))
}

/** The New session screen, in the given project or the selected one; a shown one keeps its agent. */
export function openNewSession(projectPath: string | null, agentId: AgentId | null): void {
  useViewStore.setState((s) => ({
    main: s.main.kind === 'new' ? s.main : { kind: 'new', agentId },
    projectPath: projectPath ?? s.projectPath,
    settings: { ...s.settings, open: false },
  }))
}

/** Without a section, shows the one shown last; with one, switches to it even when already open. */
export function openSettings(section: SettingsSection | null = null): void {
  useViewStore.setState((s) => ({
    settings: { open: true, section: section ?? s.settings.section },
  }))
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
