import { lazy, Suspense, useEffect } from 'react'
import { usePendingSession } from '@renderer/app/actions'
import { Welcome } from '@renderer/features/home/welcome'
import { LaunchState } from '@renderer/features/shell/launch-state'
import { SidePanelArea } from '@renderer/features/shell/side-panel-area'
import { NewSessionView } from '@renderer/features/session/new-session'
import { PendingSessionView } from '@renderer/features/session/pending-session'
import { SessionView } from '@renderer/features/session/session-view'
import { showProject } from '@renderer/stores/git'
import { useProjectsStore } from '@renderer/stores/projects'
import { isScratchFolder, useSessionsStore } from '@renderer/stores/sessions'
import { useViewStore } from '@renderer/stores/view'

const UsagePage = lazy(() => import('@renderer/features/usage/usage-page'))

/**
 * What the main area shows: Welcome, New session, a session being created, a session, in a project
 * or in a scratch folder, or the usage page.
 */
export function MainArea() {
  const projects = useProjectsStore((s) => s.projects)
  const loaded = useProjectsStore((s) => s.loaded)
  const selected = useViewStore((s) => s.projectPath)
  const main = useViewStore((s) => s.main)
  const pending = usePendingSession((s) => s.pending)
  const sessionExists = useSessionsStore((s) => main.kind === 'session' && !!s.byId[main.sessionId])
  // A session started with No project, or one being created there, shows in its scratch folder.
  const scratch = useSessionsStore((s) => {
    const path =
      pending?.projectPath ??
      (!pending && main.kind === 'session' ? s.byId[main.sessionId]?.projectPath : null)
    return path && isScratchFolder(s.byId, path) ? path : null
  })

  const project = projects.find((p) => p.path === selected) ?? projects[0] ?? null
  const projectPath = scratch ?? project?.path ?? null

  useEffect(() => {
    showProject(projectPath)
  }, [projectPath])

  if (main.kind === 'usage') {
    return (
      <Suspense fallback={null}>
        <UsagePage />
      </Suspense>
    )
  }
  if (pending && pending.projectPath === null) return <PendingSessionView pending={pending} />
  if (main.kind === 'new' && main.noProject) return <NewSessionView project={null} noProject />
  if (scratch) {
    return (
      <SidePanelArea projectPath={scratch}>
        {pending ? (
          <PendingSessionView pending={pending} />
        ) : (
          main.kind === 'session' && <SessionView key={main.sessionId} sessionId={main.sessionId} />
        )}
      </SidePanelArea>
    )
  }
  // New session asks for no project; without one, it offers to open one.
  if (loaded && !project && main.kind === 'new') return <NewSessionView project={null} />
  if (loaded && !project) return <Welcome />
  if (!project) return <LaunchState />

  let content
  if (pending && pending.projectPath === project.path) {
    content = <PendingSessionView pending={pending} />
  } else if (main.kind === 'new') {
    content = <NewSessionView project={project} />
  } else if (main.kind === 'session' && sessionExists) {
    content = <SessionView key={main.sessionId} sessionId={main.sessionId} />
  } else {
    // Launch has not decided yet; a shown session that went away leaves through followShownSession.
    return <LaunchState />
  }
  return <SidePanelArea projectPath={project.path}>{content}</SidePanelArea>
}
