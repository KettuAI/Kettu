import { useEffect } from 'react'
import { usePendingSession } from '@renderer/app/actions'
import { ProjectHome } from '@renderer/features/home/project-home'
import { Welcome } from '@renderer/features/home/welcome'
import { LaunchState } from '@renderer/features/shell/launch-state'
import { NewSessionView } from '@renderer/features/session/new-session'
import { PendingSessionView } from '@renderer/features/session/pending-session'
import { SessionView } from '@renderer/features/session/session-view'
import { TerminalArea } from '@renderer/features/terminal/terminal-area'
import { showProject } from '@renderer/stores/git'
import { useProjectsStore } from '@renderer/stores/projects'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useViewStore } from '@renderer/stores/view'

/**
 * What the main area shows: Welcome, a project's home, New session, a session being created, or a
 * session.
 */
export function MainArea() {
  const projects = useProjectsStore((s) => s.projects)
  const loaded = useProjectsStore((s) => s.loaded)
  const selected = useViewStore((s) => s.projectPath)
  const main = useViewStore((s) => s.main)
  const pending = usePendingSession((s) => s.pending)
  const sessionExists = useSessionsStore((s) => main.kind === 'session' && !!s.byId[main.sessionId])

  const project = projects.find((p) => p.path === selected) ?? projects[0] ?? null
  const projectPath = project?.path ?? null

  useEffect(() => {
    showProject(projectPath)
  }, [projectPath])

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
    content = <ProjectHome project={project} />
  }
  return <TerminalArea projectPath={project.path}>{content}</TerminalArea>
}
