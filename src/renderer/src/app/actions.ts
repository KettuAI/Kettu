import type { SessionSummary } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import {
  clearDraft,
  draftedSessions,
  NEW_SESSION_DRAFT,
  writeDraft,
} from '@renderer/features/session/composer/drafts'
import { loadMarkdown, preloadRenderers } from '@renderer/features/session/markdown/preload'
import { errorCode, errorMessage, host } from '@renderer/lib/host'
import { clearPicks, noteStarting, type OptionValues } from '@renderer/stores/agent-options'
import { useProjectsStore } from '@renderer/stores/projects'
import { isScratchFolder, useSessionsStore } from '@renderer/stores/sessions'
import { useSettingsStore } from '@renderer/stores/settings'
import { focusSession, forgetSession } from '@renderer/stores/threads'
import { openNewSession, openSession, placeNewSession, useViewStore } from '@renderer/stores/view'
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
  if (path) newSession(path)
}

/**
 * The New session screen, with the default agent, in the given project or the selected one; with
 * No project when asked, or when the selected folder is a scratch session's.
 */
export function newSession(projectPath: string | null = null, noProject = false): void {
  openNewSession(...newSessionStart(projectPath, noProject))
}

/**
 * New session as `newSession` opens it, in place of what the main area showed, such as a session
 * that went; Settings stays as it is.
 */
export function newSessionInPlace(projectPath: string | null = null, noProject = false): void {
  placeNewSession(...newSessionStart(projectPath, noProject))
}

function newSessionStart(
  projectPath: string | null,
  noProject: boolean,
): [string | null, AgentId | null, boolean] {
  const selected = useViewStore.getState().projectPath
  const inScratch =
    projectPath === null &&
    selected !== null &&
    isScratchFolder(useSessionsStore.getState().byId, selected)
  return [
    projectPath,
    useSettingsStore.getState().settings.general.defaultAgent,
    noProject || inScratch,
  ]
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
    // Deleted, or its project removed, while it started: nothing is left to show, and the first
    // message is still New session's draft.
    if (errorCode(error) === 'not_found') {
      const current = usePendingSession.getState().pending
      if (current?.agentId === agentId && current.projectPath === projectPath) {
        usePendingSession.setState({ pending: null })
      }
      return
    }
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
 * New session's send: creates the session with its first message, as a sub-session when the
 * screen was opened for one and its parent is still listed.
 */
export function startNewSession(
  agentId: AgentId,
  projectPath: string | null,
  prompt: string,
  options: OptionValues | null,
): Promise<void> {
  const { main } = useViewStore.getState()
  const parent =
    main.kind === 'new' && main.parentId
      ? useSessionsStore.getState().byId[main.parentId]
      : undefined
  return parent
    ? createSession(agentId, parent.projectPath, parent.id, prompt, options)
    : createSession(agentId, projectPath, null, prompt, options)
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
 * session, and has the host read its options when none are known; a failure shows when the
 * session is created.
 */
export function warmAgent(agentId: AgentId): void {
  noteStarting(agentId, 1)
  host('agents.start', { agentId })
    .catch((error: unknown) =>
      console.warn(`Could not start ${agentId} ahead of the session: ${errorMessage(error)}`),
    )
    .finally(() => noteStarting(agentId, -1))
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
  const { main } = useViewStore.getState()
  if (main.kind === 'session' && closed.includes(main.sessionId)) leaveSession(summary)
}

/** A null or empty title goes back to the agent's. */
export async function renameSession(sessionId: string, title: string | null): Promise<void> {
  await host('sessions.rename', { sessionId, title })
}

/** Removing it from the list takes it off screen too, through `followShownSession`. */
export async function deleteSession(sessionId: string): Promise<void> {
  await host('sessions.delete', { sessionId })
  forgetSession(sessionId)
  clearDraft(sessionId)
  useSessionsStore.getState().remove(sessionId)
}

/** A session the host removed: off the list, its replica dropped and its draft cleared. */
export function sessionRemoved(sessionId: string): void {
  useSessionsStore.getState().remove(sessionId)
  forgetSession(sessionId)
  clearDraft(sessionId)
}

/**
 * Asks the host for its one-time removal of the sessions left with no message, keeping those
 * with an unsent draft, which only the renderer knows of.
 */
export async function removeEmptySessions(): Promise<void> {
  try {
    await host('sessions.removeEmpty', { keep: draftedSessions() })
  } catch (error) {
    console.warn(`Could not remove the sessions with no message: ${errorMessage(error)}`)
  }
}

/** After the shown session goes: New session where it ran, with No project for a scratch one. */
function leaveSession(summary: SessionSummary | undefined): void {
  if (summary?.scratch) newSessionInPlace(null, true)
  else newSessionInPlace(summary?.projectPath ?? null)
}

/**
 * Leaves a shown session that drops out of the list, deleted here, by the agent host or with its
 * parent, for New session where it ran; New session for a sub-session whose parent goes becomes
 * one for a session of its own. Returns the unsubscribe.
 */
export function followShownSession(): () => void {
  return useSessionsStore.subscribe((state, previous) => {
    const { main } = useViewStore.getState()
    const shownId =
      main.kind === 'session' ? main.sessionId : main.kind === 'new' ? main.parentId : undefined
    if (!shownId || state.byId[shownId]) return
    const gone = previous.byId[shownId]
    if (gone) leaveSession(gone)
  })
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
