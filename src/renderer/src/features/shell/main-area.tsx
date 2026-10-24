import { lazy, Suspense, useEffect } from 'react'
import { usePendingSession } from '@renderer/app/actions'
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
const ArtifactsPage = lazy(() => import('@renderer/features/artifacts/artifacts-page'))
const ArtifactViewer = lazy(() => import('@renderer/features/artifacts/artifact-viewer'))

/**
 * What the main area shows: New session, a session being created, a session, in a project or in a
 * scratch folder, the usage page, the Artifacts page, or an artifact.
 */
export function MainArea() {
  const projects = useProjectsStore((s) => s.projects)
  const loaded = useProjectsStore((s) => s.loaded)
  const selected = useViewStore((s) => s.projectPath)
  const main = useViewStore((s) => s.main)
  const pending = usePendingSession((s) => s.pending)
  const sessionExists = useSessionsStore((s) => main.kind === 'session' && !!s.byId[main.sessionId])
  // A session started with No project, one being created there, and New session for a
  // sub-session of one show in its scratch folder.
  const scratch = useSessionsStore((s) => {
    const shown =
      main.kind === 'session' ? main.sessionId : main.kind === 'new' ? main.parentId : undefined
    const path = pending?.projectPath ?? (!pending && shown ? s.byId[shown]?.projectPath : null)
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
  if (main.kind === 'artifacts') {
    return (
      <Suspense fallback={null}>
        <ArtifactsPage deleted={main.deleted === true} />
      </Suspense>
    )
  }
  if (main.kind === 'artifact') {
    return (
      <Suspense fallback={null}>
        <ArtifactViewer key={main.id} id={main.id} history={main.history === true} />
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
        ) : main.kind === 'new' ? (
          <NewSessionView project={null} />
        ) : (
          main.kind === 'session' && <SessionView key={main.sessionId} sessionId={main.sessionId} />
        )}
      </SidePanelArea>
    )
  }
  // New session asks for no project; without one, it offers to open one.
  if (loaded && !project && main.kind === 'new') return <NewSessionView project={null} />
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
