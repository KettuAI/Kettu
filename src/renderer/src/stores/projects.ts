import { create } from 'zustand'
import type { NoProject, Project, SessionSummary } from '@shared/agent-host'
import { errorMessage, host, hostAt } from '@renderer/lib/host'
import { hostOfPath } from '@renderer/lib/host-paths'

export interface ProjectUpdatePatch {
  name?: string | null
  folders?: string[]
}

/** All source folders associated with a project, primary folder first. */
export function projectFolders(project: Pick<Project, 'path' | 'folders'>): string[] {
  return project.folders && project.folders.length > 0 ? project.folders : [project.path]
}

/** Whether `folderPath` is the project's primary path or one of its additional source folders. */
export function projectOwnsPath(
  project: Pick<Project, 'path' | 'folders'>,
  folderPath: string,
): boolean {
  return project.path === folderPath || (project.folders?.includes(folderPath) ?? false)
}

/** Whether a specific source folder of `project` is currently missing on disk. */
export function isFolderMissing(
  project: Pick<Project, 'path' | 'missing' | 'missingFolders'>,
  folderPath: string,
): boolean {
  if (folderPath === project.path) return project.missing
  return project.missingFolders?.includes(folderPath) ?? false
}

/** Finds the project that directly owns `folderPath` (primary path preferred, then additional). */
export function findProjectForPath(
  projects: readonly Project[],
  folderPath: string,
): Project | undefined {
  return (
    projects.find((p) => p.path === folderPath) ??
    projects.find((p) => p.folders?.includes(folderPath))
  )
}

/** Finds the project a session belongs to, preserving association after secondary folder removal. */
export function findProjectForSession(
  projects: readonly Project[],
  session: Pick<SessionSummary, 'projectPath' | 'projectOwner'>,
): Project | undefined {
  return (
    findProjectForPath(projects, session.projectPath) ??
    (session.projectOwner ? projects.find((p) => p.path === session.projectOwner) : undefined)
  )
}

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
  update(path: string, patch: ProjectUpdatePatch): Promise<Project>
  remove(path: string): Promise<void>
  /** Puts a project just before another of its host's, or last with null, as its host keeps it. */
  move(path: string, before: string | null): Promise<void>
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

/** `projects` with `path` put just before `before`, or after its host's last project with null. */
export function withProjectMoved(
  projects: readonly Project[],
  path: string,
  before: string | null,
): Project[] {
  const project = projects.find((p) => p.path === path)
  if (!project) return [...projects]
  const rest = projects.filter((p) => p !== project)
  const hostId = hostOfPath(path)
  const at = before
    ? rest.findIndex((p) => p.path === before)
    : rest.findLastIndex((p) => hostOfPath(p.path) === hostId) + 1
  rest.splice(at < 0 ? rest.length : at, 0, project)
  return rest
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
    set((state) => {
      // A host that keeps the user's order puts a new project last; its list follows.
      const listed = state.projects.some((p) => p.path === project.path)
      if (project.order != null && listed) return {}
      const others = state.projects.filter((p) => p.path !== project.path)
      return {
        projects:
          project.order != null
            ? withProjectMoved([...others, project], project.path, null)
            : [project, ...others],
      }
    })
    return project
  },
  async update(path, patch) {
    const updated = await host('projects.update', { path, ...patch })
    set((state) => ({
      projects: state.projects.map((p) => (p.path === updated.path ? updated : p)),
    }))
    return updated
  },
  async remove(path) {
    await host('projects.remove', { path })
    set((state) => ({ projects: state.projects.filter((p) => p.path !== path) }))
  },
  async move(path, before) {
    const moved = withProjectMoved(useProjectsStore.getState().projects, path, before)
    set({ projects: moved })
    try {
      await host('projects.move', { path, before })
    } catch (error) {
      // Its host's list comes again unless another change already replaced this one.
      if (useProjectsStore.getState().projects === moved) {
        const hostId = hostOfPath(path)
        void hostAt(hostId, 'projects.list', undefined)
          .then((projects) => useProjectsStore.getState().setAll(projects, hostId))
          .catch(() => {})
      }
      throw error
    }
  },
}))
