import { create } from 'zustand'
import type { Project } from '@shared/agent-host'
import { errorMessage, host } from '@renderer/lib/host'
import { hostOfPath } from '@renderer/lib/host-paths'

interface ProjectsStore {
  /** This computer's projects, then each other host's, each host's most recently opened first. */
  projects: Project[]
  /** Whether this computer's list came; another host's comes with its connection. */
  loaded: boolean
  /** Why this computer's list could not be read, until a later read succeeds. */
  error: string | null
  /** Replaces the projects of one host, null being this computer, and leaves the others'. */
  setAll(projects: Project[], hostId?: string | null): void
  refresh(): Promise<void>
  add(path: string): Promise<Project>
  remove(path: string): Promise<void>
}

/** `projects` with one host's replaced, this computer's first. */
export function withHostProjects(
  projects: readonly Project[],
  hostId: string | null,
  replacing: readonly Project[],
): Project[] {
  const others = projects.filter((p) => hostOfPath(p.path) !== hostId)
  return hostId === null ? [...replacing, ...others] : [...others, ...replacing]
}

export const useProjectsStore = create<ProjectsStore>()((set) => ({
  projects: [],
  loaded: false,
  error: null,
  setAll(projects, hostId = null) {
    set((state) => ({
      projects: withHostProjects(state.projects, hostId, projects),
      ...(hostId === null ? { loaded: true, error: null } : {}),
    }))
  },
  async refresh() {
    try {
      const projects = await host('projects.list', undefined)
      useProjectsStore.getState().setAll(projects)
    } catch (error) {
      set({ error: errorMessage(error) })
      throw error
    }
  },
  async add(path) {
    const project = await host('projects.add', { path })
    set((state) => ({
      projects: [project, ...state.projects.filter((p) => p.path !== project.path)],
    }))
    return project
  },
  async remove(path) {
    await host('projects.remove', { path })
    set((state) => ({ projects: state.projects.filter((p) => p.path !== path) }))
  },
}))
