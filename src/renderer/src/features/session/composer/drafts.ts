import { isAttachment, type Attachment } from '@shared/thread'
import { removeKey } from '@renderer/lib/storage'

// Unsent composer text and attachments per session, in localStorage under `draft:<sessionId>` as
// JSON `{ text, attachments }`, written 300 ms after the last change. One stored as plain text,
// before drafts had attachments, reads as text alone. A draft that is too large or fails to save
// stays in memory.

/** The New session screen's draft, kept like a session's until the session it starts exists. */
export const NEW_SESSION_DRAFT = 'new'

/** A draft's attachment as stored: the host's record of it, and what the tile shows about it. */
export interface SavedAttachment {
  attachment: Attachment
  pixels: { width: number; height: number } | null
  scaled: { width: number; height: number } | null
}

interface Draft {
  text: string
  attachments: SavedAttachment[]
}

const WRITE_DELAY_MS = 300
const MAX_DRAFT_BYTES = 1024 * 1024

const memory = new Map<string, Draft>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()

const PREFIX = 'draft:'
const key = (sessionId: string) => `${PREFIX}${sessionId}`
const EMPTY: Draft = { text: '', attachments: [] }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isSize = (value: unknown): value is { width: number; height: number } | null =>
  value === null ||
  (isRecord(value) && typeof value.width === 'number' && typeof value.height === 'number')

function isSaved(value: unknown): value is SavedAttachment {
  return (
    isRecord(value) &&
    isAttachment(value.attachment) &&
    isSize(value.pixels) &&
    isSize(value.scaled)
  )
}

/** A stored draft; one stored as plain text, or that is not a draft's JSON, is text alone. */
export function parseDraft(raw: string): Draft {
  if (raw.startsWith('{')) {
    try {
      const value: unknown = JSON.parse(raw)
      if (isRecord(value) && typeof value.text === 'string' && Array.isArray(value.attachments)) {
        return { text: value.text, attachments: value.attachments.filter(isSaved) }
      }
    } catch {
      // Text that only starts like JSON.
    }
  }
  return { text: raw, attachments: [] }
}

function read(sessionId: string): Draft {
  const kept = memory.get(sessionId)
  if (kept) return kept
  try {
    const raw = localStorage.getItem(key(sessionId))
    return raw === null ? EMPTY : parseDraft(raw)
  } catch {
    return EMPTY
  }
}

export function readDraft(sessionId: string): string {
  return read(sessionId).text
}

export function readDraftAttachments(sessionId: string): SavedAttachment[] {
  return read(sessionId).attachments
}

/** Whether a draft holds what Send takes: text other than white space, or an attachment. */
export function hasMessage(text: string, attachments: readonly unknown[]): boolean {
  return text.trim().length > 0 || attachments.length > 0
}

function write(sessionId: string, draft: Draft): void {
  memory.set(sessionId, draft)
  const timer = timers.get(sessionId)
  if (timer) clearTimeout(timer)
  timers.set(
    sessionId,
    setTimeout(() => flushDraft(sessionId), WRITE_DELAY_MS),
  )
}

export function writeDraft(sessionId: string, text: string): void {
  write(sessionId, { ...read(sessionId), text })
}

export function writeDraftAttachments(sessionId: string, attachments: SavedAttachment[]): void {
  write(sessionId, { ...read(sessionId), attachments })
}

/** Writes a pending draft now, for example when the composer unmounts. */
export function flushDraft(sessionId: string): void {
  const timer = timers.get(sessionId)
  if (timer) clearTimeout(timer)
  timers.delete(sessionId)
  const draft = memory.get(sessionId)
  if (draft === undefined) return
  if (!draft.text && draft.attachments.length === 0) {
    removeKey(key(sessionId))
    memory.delete(sessionId)
    return
  }
  const value = JSON.stringify(draft)
  if (value.length * 2 > MAX_DRAFT_BYTES) {
    console.warn(`Draft for ${sessionId} is over 1 MB; keeping it in memory only`)
    return
  }
  try {
    localStorage.setItem(key(sessionId), value)
    memory.delete(sessionId)
  } catch (error) {
    console.warn(`Could not save the draft for ${sessionId}; keeping it in memory`, error)
  }
}

/** Every draft, saved or in memory, New session's included. */
export function draftIds(): string[] {
  const ids = new Set(memory.keys())
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const name = localStorage.key(i)
      if (name?.startsWith(PREFIX)) ids.add(name.slice(PREFIX.length))
    }
  } catch {
    // Without storage only the drafts in memory count.
  }
  return [...ids].sort()
}

/** The sessions whose draft, saved or in memory, holds more than white space or an attachment. */
export function draftedSessions(): string[] {
  return draftIds().filter((id) => {
    if (id === NEW_SESSION_DRAFT) return false
    const draft = read(id)
    return draft.text.trim() !== '' || draft.attachments.length > 0
  })
}

export function clearDraft(sessionId: string): void {
  const timer = timers.get(sessionId)
  if (timer) clearTimeout(timer)
  timers.delete(sessionId)
  memory.delete(sessionId)
  removeKey(key(sessionId))
}
