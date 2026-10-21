import { create } from 'zustand'
import type { Project } from '@shared/agent-host'
import { host } from '@renderer/lib/host'

interface ProjectsStore {
  projects: Project[]
  loaded: boolean
  setAll(projects: Project[]): void
  refresh(): Promise<void>
  add(path: string): Promise<Project>
  remove(path: string): Promise<void>
}

export const useProjectsStore = create<ProjectsStore>()((set) => ({
  projects: [],
  loaded: false,
  setAll(projects) {
    set({ projects, loaded: true })
  },
  async refresh() {
    set({ projects: await host('projects.list', undefined), loaded: true })
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
