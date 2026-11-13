import { usePendingSession } from '@renderer/app/actions'
import { NewSessionView } from '@renderer/features/session/new-session'
import { PendingSessionView } from '@renderer/features/session/pending-session'
import { ColumnScroller, HostAway, ThreadSkeleton } from '@renderer/features/session/session-states'
import { SessionView } from '@renderer/features/session/session-view'
import { ClosePaneButton } from '@renderer/features/shell/header-tools'
import { NoDrag, TopBar } from '@renderer/features/shell/top-bar'
import { hostOfPath } from '@renderer/lib/host-paths'
import { isAway, useOtherHost } from '@renderer/stores/hosts'
import { useProjectsStore } from '@renderer/stores/projects'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useViewStore } from '@renderer/stores/view'
import { findPane } from './layout'
import { usePane } from './pane-context'

/** What a pane shows: a session, a session being created, or New session. */
export function PaneContent({ paneId }: { paneId: string }) {
  const view = useViewStore((s) => findPane(s.layout, paneId)?.view)
  const pending = usePendingSession((s) =>
    s.pending && s.pending.paneId === paneId ? s.pending : null,
  )
  const projects = useProjectsStore((s) => s.projects)
  const selected = useViewStore((s) => s.projectPath)
  const listed = useSessionsStore((s) => view?.kind === 'session' && !!s.byId[view.sessionId])
  if (!view) return null
  if (pending) return <PendingSessionView key={`${paneId}:pending`} pending={pending} />
  if (view.kind === 'session') {
    const hostId = hostOfPath(view.projectPath)
    if (!listed && hostId !== null) return <WaitingForHost hostId={hostId} />
    return <SessionView key={`${paneId}:${view.sessionId}`} sessionId={view.sessionId} />
  }
  // New session with no project of its own starts in the one selected, as the main area had it;
  // with a host chosen, in a project on that host.
  const onHost = (path: string) => view.hostId === undefined || hostOfPath(path) === view.hostId
  const path = view.noProject
    ? null
    : ([view.projectPath, selected].find((p) => p && onHost(p)) ?? null)
  const project = path
    ? (projects.find((p) => p.path === path) ?? null)
    : view.noProject
      ? null
      : (projects.find((p) => onHost(p.path)) ?? null)
  return (
    <NewSessionView
      key={`${paneId}:new`}
      paneId={paneId}
      project={project}
      noProject={view.noProject}
      hostId={view.hostId ?? null}
      parentId={view.parentId ?? null}
    />
  )
}

/** A pane kept from the last run for a session its host has not listed since: it waits for it. */
function WaitingForHost({ hostId }: { hostId: string }) {
  const host = useOtherHost(hostId)
  return (
    <div className="ks-session flex h-full min-h-0 flex-col">
      <TopBar cornered={usePane()?.cornered}>
        <span className="flex-1" />
        <NoDrag className="kp-bar-tools">
          <ClosePaneButton />
        </NoDrag>
      </TopBar>
      {host && isAway(host.connection) ? (
        <ColumnScroller className="flex items-center justify-center px-6 pb-16">
          <HostAway host={host} />
        </ColumnScroller>
      ) : (
        <ColumnScroller>
          <ThreadSkeleton />
        </ColumnScroller>
      )}
    </div>
  )
}
