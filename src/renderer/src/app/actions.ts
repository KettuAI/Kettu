import type { SessionSummary } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import {
  clearDraft,
  NEW_SESSION_DRAFT,
  writeDraft,
} from '@renderer/features/session/composer/drafts'
import { loadMarkdown, preloadRenderers } from '@renderer/features/session/markdown/preload'
import { errorCode, errorMessage, host } from '@renderer/lib/host'
import { clearPicks, type OptionValues } from '@renderer/stores/agent-options'
import { useProjectsStore } from '@renderer/stores/projects'
import { isScratchFolder, useSessionsStore } from '@renderer/stores/sessions'
import { useSettingsStore } from '@renderer/stores/settings'
import { focusSession, forgetSession } from '@renderer/stores/threads'
import { openNewSession, openProjectHome, openSession, useViewStore } from '@renderer/stores/view'
import { create } from 'zustand'

/** A session being created: shown in place of the thread until `session/new` answers. */
export interface PendingSession {
  agentId: AgentId
  projectPath: string | null // null: No project, whose folder the host makes
  parentId: string | null
  /** The first message, from the New session screen, sent once the session exists. */
  prompt: string | null
  /** The config values New session chose, set once the session exists. */
  options: OptionValues | null
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

/**
 * The New session screen, with the default agent, in the given project or the selected one; with
 * No project when asked, or when the selected folder is a scratch session's.
 */
export function newSession(projectPath: string | null = null, noProject = false): void {
  const selected = useViewStore.getState().projectPath
  const inScratch =
    projectPath === null &&
    selected !== null &&
    isScratchFolder(useSessionsStore.getState().byId, selected)
  openNewSession(
    projectPath,
    useSettingsStore.getState().settings.general.defaultAgent,
    noProject || inScratch,
  )
}

/** Starts a session in the project, or with a null `projectPath` in a scratch folder. */
export async function createSession(
  agentId: AgentId,
  projectPath: string | null,
  parentId: string | null = null,
  prompt: string | null = null,
  options: OptionValues | null = null,
): Promise<void> {
  usePendingSession.setState({
    pending: { agentId, projectPath, parentId, prompt, options, error: null },
  })
  useViewStore.setState((s) => ({
    projectPath: projectPath ?? s.projectPath,
    settings: { ...s.settings, open: false },
  }))
  preloadRenderers()
  try {
    const summary = await host('sessions.create', {
      agentId,
      projectPath,
      ...(parentId ? { parentId } : {}),
      ...(options && Object.keys(options).length > 0 ? { options } : {}),
    })
    // The host now remembers what carries over; the rest starts afresh next time.
    if (options) clearPicks(agentId)
    useSessionsStore.getState().upsert(summary)
    if (prompt !== null) await sendFirstPrompt(summary, prompt)
    // The session shows with its thread and renderer ready, so no skeleton flashes in between.
    await Promise.all([focusSession(summary.id), loadMarkdown().catch(() => {})])
    const current = usePendingSession.getState().pending
    if (current?.agentId === agentId && current.projectPath === projectPath) {
      usePendingSession.setState({ pending: null })
      openSession(summary.id, summary.projectPath)
    }
  } catch (error) {
    usePendingSession.setState({
      pending: {
        agentId,
        projectPath,
        parentId,
        prompt,
        options,
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

/**
 * Starts the agent while the New session screen is shown, so the first send waits only for the
 * session; a failure shows when the session is created.
 */
export function warmAgent(agentId: AgentId): void {
  host('agents.start', { agentId }).catch((error: unknown) =>
    console.warn(`Could not start ${agentId} ahead of the session: ${errorMessage(error)}`),
  )
}

/**
 * Forks the session into a new one in the same project and shows it; from `entryId`, a reply's
 * agent message, up to the end of that reply's turn.
 */
export async function forkSession(sessionId: string, entryId?: string): Promise<void> {
  const summary = await host('sessions.fork', entryId ? { sessionId, entryId } : { sessionId })
  useSessionsStore.getState().upsert(summary)
  openSession(summary.id, summary.projectPath)
}

export function cancelPendingSession(): void {
  usePendingSession.setState({ pending: null })
}

export function retryPendingSession(): void {
  const pending = usePendingSession.getState().pending
  if (pending) {
    void createSession(
      pending.agentId,
      pending.projectPath,
      pending.parentId,
      pending.prompt,
      pending.options,
    )
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

/** A null or empty title goes back to the agent's. */
export async function renameSession(sessionId: string, title: string | null): Promise<void> {
  await host('sessions.rename', { sessionId, title })
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
