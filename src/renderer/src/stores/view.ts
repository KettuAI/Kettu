import { create } from 'zustand'
import { readJson, writeJson } from '@renderer/lib/storage'

export type MainView =
  | { kind: 'home' } // Welcome without projects, else the selected project's home
  | { kind: 'session'; sessionId: string }

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
  settings: { open: boolean; section: SettingsSection | null }
  sidebarCollapsed: boolean
  /** Project groups the user collapsed; open by default. */
  collapsedProjects: Record<string, true>
  /** Parent sessions the user collapsed or expanded; others follow activity. */
  expandedParents: Record<string, boolean>
  terminalOpen: Record<string, boolean>
  terminalMaximized: boolean
}

interface Persisted {
  projectPath: string | null
  lastSessionId: string | null
  sidebarCollapsed: boolean
  collapsedProjects: Record<string, true>
  expandedParents: Record<string, boolean>
  terminalOpen: Record<string, boolean>
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
  terminalOpen: saved.terminalOpen ?? {},
  terminalMaximized: false,
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
      terminalOpen: state.terminalOpen,
    }
    writeJson(KEY, persisted)
  }, 300)
})

export function openSession(sessionId: string, projectPath: string): void {
  useViewStore.setState({
    main: { kind: 'session', sessionId },
    projectPath,
    settings: { open: false, section: null },
  })
}

export function openProjectHome(projectPath: string | null): void {
  useViewStore.setState({
    main: { kind: 'home' },
    projectPath,
    settings: { open: false, section: null },
  })
}

export function openSettings(section: SettingsSection | null = null): void {
  useViewStore.setState({ settings: { open: true, section } })
}

export function closeSettings(): void {
  useViewStore.setState({ settings: { open: false, section: null } })
}

export function toggleSidebar(): void {
  useViewStore.setState((s) => ({ sidebarCollapsed: !s.sidebarCollapsed }))
}

export function toggleTerminal(projectPath: string, open?: boolean): void {
  useViewStore.setState((s) => ({
    terminalOpen: { ...s.terminalOpen, [projectPath]: open ?? !s.terminalOpen[projectPath] },
    terminalMaximized: false,
  }))
}
