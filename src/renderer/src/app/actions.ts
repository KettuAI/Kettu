import type { AgentId } from '@shared/thread'
import { clearDraft } from '@renderer/features/session/composer/drafts'
import { errorCode, errorMessage, host } from '@renderer/lib/host'
import { useProjectsStore } from '@renderer/stores/projects'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useSettingsStore } from '@renderer/stores/settings'
import { forgetSession } from '@renderer/stores/threads'
import { openProjectHome, openSession, useViewStore } from '@renderer/stores/view'
import { create } from 'zustand'

/** A session being created: shown in place of the thread until `session/new` answers. */
export interface PendingSession {
  agentId: AgentId
  projectPath: string
  parentId: string | null
  error: { message: string; code: string | null } | null
}

export const usePendingSession = create<{ pending: PendingSession | null }>()(() => ({
  pending: null,
}))

export async function openProjectDialog(): Promise<void> {
  const path = await window.overbench.dialogs.openProject()
  if (!path) return
  const project = await useProjectsStore.getState().add(path)
  openProjectHome(project.path)
}

/** New session in the current project: with the default agent, or on the project home. */
export function newSession(): void {
  const { projectPath } = useViewStore.getState()
  const project = projectPath ?? useProjectsStore.getState().projects[0]?.path ?? null
  if (!project) {
    void openProjectDialog()
    return
  }
  const agent = useSettingsStore.getState().settings.general.defaultAgent
  if (agent) void createSession(agent, project)
  else openProjectHome(project)
}

export async function createSession(
  agentId: AgentId,
  projectPath: string,
  parentId: string | null = null,
): Promise<void> {
  usePendingSession.setState({ pending: { agentId, projectPath, parentId, error: null } })
  useViewStore.setState((s) => ({ projectPath, settings: { ...s.settings, open: false } }))
  try {
    const summary = await host('sessions.create', {
      agentId,
      projectPath,
      ...(parentId ? { parentId } : {}),
    })
    useSessionsStore.getState().upsert(summary)
    const current = usePendingSession.getState().pending
    if (current?.agentId === agentId && current.projectPath === projectPath) {
      usePendingSession.setState({ pending: null })
      openSession(summary.id, projectPath)
    }
  } catch (error) {
    usePendingSession.setState({
      pending: {
        agentId,
        projectPath,
        parentId,
        error: { message: errorMessage(error), code: errorCode(error) },
      },
    })
  }
}

export function cancelPendingSession(): void {
  usePendingSession.setState({ pending: null })
}

export function retryPendingSession(): void {
  const pending = usePendingSession.getState().pending
  if (pending) void createSession(pending.agentId, pending.projectPath, pending.parentId)
}

/** Drops the live state of the session and its sub-sessions; opening one loads it again. */
export async function closeSession(sessionId: string): Promise<void> {
  const summary = useSessionsStore.getState().byId[sessionId]
  const closed = [sessionId, ...descendantIds(sessionId)]
  await host('sessions.close', { sessionId })
  for (const id of closed) forgetSession(id)
  const view = useViewStore.getState()
  if (view.main.kind === 'session' && closed.includes(view.main.sessionId)) {
    openProjectHome(summary?.projectPath ?? view.projectPath)
  }
}

export async function deleteSession(sessionId: string): Promise<void> {
  const summary = useSessionsStore.getState().byId[sessionId]
  await host('sessions.delete', { sessionId })
  forgetSession(sessionId)
  clearDraft(sessionId)
  useSessionsStore.getState().remove(sessionId)
  const view = useViewStore.getState()
  if (view.main.kind === 'session' && view.main.sessionId === sessionId) {
    openProjectHome(summary?.projectPath ?? view.projectPath)
  }
}

/** All sessions under a session, for the confirmation that names how many go with it. */
export function descendantCount(sessionId: string): number {
  return descendantIds(sessionId).length
}

function descendantIds(sessionId: string): string[] {
  const { byId } = useSessionsStore.getState()
  const ids: string[] = []
  const walk = (id: string) => {
    for (const s of Object.values(byId)) {
      if (s.parentId === id) {
        ids.push(s.id)
        walk(s.id)
      }
    }
  }
  walk(sessionId)
  return ids
}

/** Collects the diagnostics bundle and asks main where to save it; null when cancelled. */
export async function exportDiagnostics(): Promise<string | null> {
  const bundle = await host('diagnostics.collect', undefined)
  return window.overbench.diagnostics.save(bundle)
}
