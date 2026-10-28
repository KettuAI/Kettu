import { usePendingSession } from '@renderer/app/actions'
import { NewSessionView } from '@renderer/features/session/new-session'
import { PendingSessionView } from '@renderer/features/session/pending-session'
import { SessionView } from '@renderer/features/session/session-view'
import { useProjectsStore } from '@renderer/stores/projects'
import { useViewStore } from '@renderer/stores/view'
import { findPane } from './layout'

/** What a pane shows: a session, a session being created, or New session. */
export function PaneContent({ paneId }: { paneId: string }) {
  const view = useViewStore((s) => findPane(s.layout, paneId)?.view)
  const pending = usePendingSession((s) =>
    s.pending && s.pending.paneId === paneId ? s.pending : null,
  )
  const projects = useProjectsStore((s) => s.projects)
  const selected = useViewStore((s) => s.projectPath)
  if (!view) return null
  if (pending) return <PendingSessionView key={`${paneId}:pending`} pending={pending} />
  if (view.kind === 'session') {
    return <SessionView key={`${paneId}:${view.sessionId}`} sessionId={view.sessionId} />
  }
  // New session with no project of its own starts in the one selected, as the main area had it.
  const path = view.noProject ? null : (view.projectPath ?? selected)
  const project = path
    ? (projects.find((p) => p.path === path) ?? null)
    : view.noProject
      ? null
      : (projects[0] ?? null)
  return (
    <NewSessionView
      key={`${paneId}:new`}
      paneId={paneId}
      project={project}
      noProject={view.noProject}
      parentId={view.parentId ?? null}
    />
  )
}
