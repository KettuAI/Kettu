// Availability checks and delivery helpers for sending selection-anchored file notes to the
// active session's agent, reusing the Files pane's selection-quote representation.

import type { SessionSummary } from '@shared/agent-host'
import type { SessionView, UserContent } from '@shared/thread'
import { host } from '@renderer/lib/host'
import { useSessionsStore } from '@renderer/stores/sessions'
import { showSending, useThreadsStore } from '@renderer/stores/threads'
import { fileNoteMessage, type FilePassage } from './file-quote'
import { quoteInComposer, type MentionMiss } from './mention-lines'

export type NoteDisabledReason =
  'no-session' | 'subagent' | 'starting' | 'held-outside' | 'unavailable'

export type NoteSendAvailability =
  | { canSend: true; mode: 'send' | 'queue' }
  | { canSend: false; mode: 'disabled'; reason: NoteDisabledReason }

export interface NoteAvailabilityInput {
  sessionId: string | null
  summary?: Pick<SessionSummary, 'status' | 'archivedAt' | 'origin'> | null
  threadSession?: Pick<
    SessionView,
    'status' | 'heldOutside' | 'waitingBackground' | 'origin'
  > | null
}

/**
 * Determines whether the target session can accept a note right now: sent immediately when idle
 * (or waiting on background work), queued while running, or disabled with a clear reason.
 */
export function noteSendAvailability({
  sessionId,
  summary,
  threadSession,
}: NoteAvailabilityInput): NoteSendAvailability {
  if (!sessionId || !summary || summary.archivedAt !== null) {
    return { canSend: false, mode: 'disabled', reason: 'no-session' }
  }
  const origin = threadSession?.origin ?? summary.origin
  if (origin === 'subagent') {
    return { canSend: false, mode: 'disabled', reason: 'subagent' }
  }
  if (threadSession?.heldOutside === true) {
    return { canSend: false, mode: 'disabled', reason: 'held-outside' }
  }
  const status = threadSession?.status ?? summary.status
  if (status === 'starting') {
    return { canSend: false, mode: 'disabled', reason: 'starting' }
  }
  if (status === 'ready' || status === 'closed') {
    return { canSend: true, mode: 'send' }
  }
  if (status === 'running' || status === 'awaiting_permission') {
    if (status === 'running' && threadSession?.waitingBackground) {
      return { canSend: true, mode: 'send' }
    }
    return { canSend: true, mode: 'queue' }
  }
  return { canSend: false, mode: 'disabled', reason: 'unavailable' }
}

/** Subscribes to the active session's send/queue availability for the Files pane's note popover. */
export function useNoteSendAvailability(sessionId: string | null): NoteSendAvailability {
  const summary = useSessionsStore((s) => (sessionId ? s.byId[sessionId] : undefined))
  const threadSession = useThreadsStore((s) =>
    sessionId ? s.replicas[sessionId]?.state?.session : undefined,
  )
  return noteSendAvailability({ sessionId, summary, threadSession })
}

export interface SendFileNoteResult {
  outcome: 'sent' | 'queued'
  itemId: string | null
  text: string
}

/**
 * Sends a note together with ONLY the anchored file selection to `sessionId` via `sessions.queue`,
 * showing it optimistically when the session is free and rolling back if queued or failed.
 */
export async function sendFileSelectionNote({
  sessionId,
  path,
  passage,
  note,
  optimistic = false,
}: {
  sessionId: string
  path: string
  passage: FilePassage
  note: string
  optimistic?: boolean
}): Promise<SendFileNoteResult> {
  const trimmed = note.trim()
  if (!trimmed) {
    throw new Error('Cannot send an empty note')
  }
  const text = fileNoteMessage(path, passage, trimmed)
  const content: UserContent[] = [{ type: 'text', text }]
  const unshow = optimistic ? showSending(sessionId, content) : null
  try {
    const { itemId } = await host('sessions.queue', { sessionId, content })
    if (itemId) {
      unshow?.()
      return { outcome: 'queued', itemId, text }
    }
    return { outcome: 'sent', itemId: null, text }
  } catch (error) {
    unshow?.({ restoreSuggestion: true })
    throw error
  }
}

/** Inserts the quoted file selection (plus any draft note) into the session's composer. */
export function insertFileNoteInComposer({
  sessionId,
  path,
  passage,
  note,
}: {
  sessionId: string
  path: string
  passage: FilePassage
  note: string
}): MentionMiss | null {
  return quoteInComposer(sessionId, fileNoteMessage(path, passage, note))
}
