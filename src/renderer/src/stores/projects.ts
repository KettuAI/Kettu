import { create } from 'zustand'
import type { NoProject, Project } from '@shared/agent-host'
import { errorMessage, host } from '@renderer/lib/host'
import { hostOfPath } from '@renderer/lib/host-paths'

interface ProjectsStore {
  /** This computer's projects, then each other host's, each host's most recently opened first. */
  projects: Project[]
  /**
   * Each host's No project group by `noProjectKey`, once read; a host that cannot pin it has none.
   */
  noProjects: Record<string, NoProject>
  /** Whether this computer's list came; another host's comes with its connection. */
  loaded: boolean
  /** Why this computer's list could not be read, until a later read succeeds. */
  error: string | null
  /** Replaces the projects of one host, null being this computer, and leaves the others'. */
  setAll(projects: Project[], hostId?: string | null): void
  /** Sets one host's No project group, or forgets it with `undefined`. */
  setNoProject(hostId: string | null, noProject: NoProject | undefined): void
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

/** The key of a host's No project group in `noProjects`, '' being this computer's. */
export function noProjectKey(hostId: string | null): string {
  return hostId ?? ''
}

/** A folder Pinned lists: a project, or with a null project a host's No project group. */
export interface PinnedFolder {
  project: Project | null
  hostId: string | null
  pinnedAt: number
}

/** The pinned projects and No project groups of `hosts`, in the order they were pinned. */
export function pinnedFolders(
  projects: readonly Project[],
  noProjects: Readonly<Record<string, NoProject>>,
  hosts: readonly (string | null)[] = [null],
): PinnedFolder[] {
  const folders: PinnedFolder[] = []
  for (const project of projects) {
    const hostId = hostOfPath(project.path)
    if (project.pinnedAt != null && hosts.includes(hostId)) {
      folders.push({ project, hostId, pinnedAt: project.pinnedAt })
    }
  }
  for (const hostId of hosts) {
    const pinnedAt = noProjects[noProjectKey(hostId)]?.pinnedAt
    if (pinnedAt != null) folders.push({ project: null, hostId, pinnedAt })
  }
  return folders.sort(
    (a, b) =>
      a.pinnedAt - b.pinnedAt || (a.project?.path ?? '').localeCompare(b.project?.path ?? ''),
  )
}

/** Whether `hostId`'s No project group is pinned. */
export function noProjectPinned(
  noProjects: Readonly<Record<string, NoProject>>,
  hostId: string | null,
): boolean {
  return noProjects[noProjectKey(hostId)]?.pinnedAt != null
}

export const useProjectsStore = create<ProjectsStore>()((set) => ({
  projects: [],
  noProjects: {},
  loaded: false,
  error: null,
  setAll(projects, hostId = null) {
    set((state) => ({
      projects: withHostProjects(state.projects, hostId, projects),
      ...(hostId === null ? { loaded: true, error: null } : {}),
    }))
  },
  setNoProject(hostId, noProject) {
    set((state) => {
      const noProjects = { ...state.noProjects }
      if (noProject) noProjects[noProjectKey(hostId)] = noProject
      else delete noProjects[noProjectKey(hostId)]
      return { noProjects }
    })
  },
  async refresh() {
    try {
      const [projects, noProject] = await Promise.all([
        host('projects.list', undefined),
        host('projects.noProject', undefined),
      ])
      useProjectsStore.getState().setAll(projects)
      useProjectsStore.getState().setNoProject(null, noProject)
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
