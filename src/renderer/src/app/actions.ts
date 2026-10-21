import type { SessionSummary } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import {
  clearDraft,
  NEW_SESSION_DRAFT,
  writeDraft,
} from '@renderer/features/session/composer/drafts'
import { errorCode, errorMessage, host } from '@renderer/lib/host'
import { useProjectsStore } from '@renderer/stores/projects'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useSettingsStore } from '@renderer/stores/settings'
import { forgetSession } from '@renderer/stores/threads'
import { openNewSession, openProjectHome, openSession, useViewStore } from '@renderer/stores/view'
import { create } from 'zustand'

/** A session being created: shown in place of the thread until `session/new` answers. */
export interface PendingSession {
  agentId: AgentId
  projectPath: string
  parentId: string | null
  /** The first message, from the New session screen, sent once the session exists. */
  prompt: string | null
  error: { message: string; code: string | null } | null
}

export const usePendingSession = create<{ pending: PendingSession | null }>()(() => ({
  pending: null,
}))

/** Asks for a folder and adds it as a project; null when cancelled. */
export async function addProjectFromDialog(): Promise<string | null> {
  const path = await window.overbench.dialogs.openProject()
  if (!path) return null
  const project = await useProjectsStore.getState().add(path)
  return project.path
}

export async function openProjectDialog(): Promise<void> {
  const path = await addProjectFromDialog()
  if (path) openProjectHome(path)
}

/** The New session screen, in the given project or the selected one, with the default agent. */
export function newSession(projectPath: string | null = null): void {
  openNewSession(projectPath, useSettingsStore.getState().settings.general.defaultAgent)
}

export async function createSession(
  agentId: AgentId,
  projectPath: string,
  parentId: string | null = null,
  prompt: string | null = null,
): Promise<void> {
  usePendingSession.setState({ pending: { agentId, projectPath, parentId, prompt, error: null } })
  useViewStore.setState((s) => ({ projectPath, settings: { ...s.settings, open: false } }))
  try {
    const summary = await host('sessions.create', {
      agentId,
      projectPath,
      ...(parentId ? { parentId } : {}),
    })
    useSessionsStore.getState().upsert(summary)
    if (prompt !== null) await sendFirstPrompt(summary, prompt)
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
        prompt,
        error: { message: errorMessage(error), code: errorCode(error) },
      },
    })
  }
}

/**
 * Sends the New session screen's message into the session it started. One the session cannot
 * take yet, as when its agent asks to sign in first, waits in that session's composer.
 */
async function sendFirstPrompt(summary: SessionSummary, prompt: string): Promise<void> {
  clearDraft(NEW_SESSION_DRAFT)
  if (summary.status === 'ready') {
    try {
      await host('sessions.prompt', {
        sessionId: summary.id,
        content: [{ type: 'text', text: prompt }],
      })
      return
    } catch (error) {
      console.warn(
        `Could not send the first message to ${summary.id}; keeping it as a draft`,
        error,
      )
    }
  }
  writeDraft(summary.id, prompt)
}

/** Forks the session into a new one in the same project and shows it. */
export async function forkSession(sessionId: string): Promise<void> {
  const summary = await host('sessions.fork', { sessionId })
  useSessionsStore.getState().upsert(summary)
  openSession(summary.id, summary.projectPath)
}

export function cancelPendingSession(): void {
  usePendingSession.setState({ pending: null })
}

export function retryPendingSession(): void {
  const pending = usePendingSession.getState().pending
  if (pending) {
    void createSession(pending.agentId, pending.projectPath, pending.parentId, pending.prompt)
  }
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
