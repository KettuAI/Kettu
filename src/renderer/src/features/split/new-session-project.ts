import type { Project } from '@shared/agent-host'
import { hostOfPath } from '@renderer/lib/host-paths'
import type { PaneView } from './layout'

/**
 * The project a New session pane starts in: its own, else the one selected, else the first on the
 * host chosen; none for No project. A host chosen before a project limits it to that host's.
 */
export function newSessionProject(
  view: Extract<PaneView, { kind: 'new' }>,
  selected: string | null,
  projects: readonly Project[],
): Project | null {
  if (view.noProject) return null
  const onHost = (path: string) => view.hostId === undefined || hostOfPath(path) === view.hostId
  const path = [view.projectPath, selected].find((p) => p && onHost(p)) ?? null
  return path
    ? (projects.find((p) => p.path === path) ?? null)
    : (projects.find((p) => onHost(p.path)) ?? null)
}
