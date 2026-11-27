import type { Project } from '@shared/agent-host'
import { hostOfPath } from '@renderer/lib/host-paths'
import { activeProjects, findProjectForPath, projectFolders } from '@renderer/stores/projects'
import type { PaneView } from './layout'

/**
 * The project a New session pane starts in: its own, else the one selected, else the first on the
 * host chosen; none for No project. A host chosen before a project limits it to that host's.
 * Archived projects are excluded so new sessions default to active projects.
 * Matches both primary paths and additional source folders.
 */
export function newSessionProject(
  view: Extract<PaneView, { kind: 'new' }>,
  selected: string | null,
  projects: readonly Project[],
): Project | null {
  if (view.noProject) return null
  const listed = activeProjects(projects)
  const onHost = (path: string) => view.hostId === undefined || hostOfPath(path) === view.hostId
  const path = [view.projectPath, selected].find((p) => p && onHost(p)) ?? null
  return path
    ? (findProjectForPath(listed, path) ?? listed.find((p) => onHost(p.path)) ?? null)
    : (listed.find((p) => onHost(p.path)) ?? null)
}

/**
 * The working directory chosen for a New session pane within `project`: the selected source folder
 * when it belongs to `project`, otherwise the project's primary path.
 */
export function newSessionFolder(
  view: Extract<PaneView, { kind: 'new' }>,
  selected: string | null,
  project: Project | null,
): string | null {
  if (view.noProject || !project) return null
  const folders = projectFolders(project)
  for (const candidate of [view.projectPath, selected]) {
    if (candidate && folders.includes(candidate)) return candidate
  }
  return project.path
}
