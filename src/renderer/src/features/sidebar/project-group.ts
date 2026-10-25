import type { Project, SessionSummary } from '@shared/agent-host'
import { sessionTree } from '@renderer/stores/sessions'

/**
 * The projects the sidebar lists: those whose group has an unpinned, unarchived session to show.
 * Pinned sessions live in their own group, so a project with only those has nothing to show here.
 */
export function visibleProjects(
  projects: readonly Project[],
  byId: Record<string, SessionSummary>,
): Project[] {
  const projectSessions = Object.fromEntries(
    Object.entries(byId).filter(([, session]) => !session.scratch),
  )
  return projects.filter((project) => sessionTree(projectSessions, project.path).length > 0)
}
