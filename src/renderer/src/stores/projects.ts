import { create } from 'zustand'
import type { Project } from '@shared/agent-host'
import { errorMessage, host } from '@renderer/lib/host'

interface ProjectsStore {
  projects: Project[]
  loaded: boolean
  /** Why the list could not be read, until a later read succeeds. */
  error: string | null
  setAll(projects: Project[]): void
  refresh(): Promise<void>
  add(path: string): Promise<Project>
  remove(path: string): Promise<void>
}

export const useProjectsStore = create<ProjectsStore>()((set) => ({
  projects: [],
  loaded: false,
  error: null,
  setAll(projects) {
    set({ projects, loaded: true, error: null })
  },
  async refresh() {
    try {
      set({ projects: await host('projects.list', undefined), loaded: true, error: null })
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
