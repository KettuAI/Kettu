import type { Project, SessionSummary } from '@shared/agent-host'
import { sessionTree } from '@renderer/stores/sessions'

/**
 * The projects the sidebar lists: those whose group has an unpinned, unarchived session or a
 * listed task to show. Pinned sessions live in their own group, so a project with only those has
 * nothing to show here. `taskGone` are the node sessions whose task was removed.
 */
export function visibleProjects(
  projects: readonly Project[],
  byId: Record<string, SessionSummary>,
  taskProjects: readonly string[] = [],
  taskGone?: ReadonlySet<string>,
): Project[] {
  const projectSessions = Object.fromEntries(
    Object.entries(byId).filter(([, session]) => !session.scratch),
  )
  return projects.filter(
    (project) =>
      taskProjects.includes(project.path) ||
      sessionTree(projectSessions, project.path, null, taskGone).length > 0,
  )
}
