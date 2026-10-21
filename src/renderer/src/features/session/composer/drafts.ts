import { removeKey } from '@renderer/lib/storage'

// Unsent composer text per session, in localStorage under `draft:<sessionId>`, written 300 ms
// after the last keystroke. A draft that is too large or fails to save stays in memory.

const WRITE_DELAY_MS = 300
const MAX_DRAFT_BYTES = 1024 * 1024

const memory = new Map<string, string>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()

const key = (sessionId: string) => `draft:${sessionId}`

export function readDraft(sessionId: string): string {
  const kept = memory.get(sessionId)
  if (kept !== undefined) return kept
  try {
    return localStorage.getItem(key(sessionId)) ?? ''
  } catch {
    return ''
  }
}

export function writeDraft(sessionId: string, text: string): void {
  memory.set(sessionId, text)
  const timer = timers.get(sessionId)
  if (timer) clearTimeout(timer)
  timers.set(
    sessionId,
    setTimeout(() => flushDraft(sessionId), WRITE_DELAY_MS),
  )
}

/** Writes a pending draft now, for example when the composer unmounts. */
export function flushDraft(sessionId: string): void {
  const timer = timers.get(sessionId)
  if (timer) clearTimeout(timer)
  timers.delete(sessionId)
  const text = memory.get(sessionId)
  if (text === undefined) return
  if (!text) {
    removeKey(key(sessionId))
    memory.delete(sessionId)
    return
  }
  if (text.length * 2 > MAX_DRAFT_BYTES) {
    console.warn(`Draft for ${sessionId} is over 1 MB; keeping it in memory only`)
    return
  }
  try {
    localStorage.setItem(key(sessionId), text)
    memory.delete(sessionId)
  } catch (error) {
    console.warn(`Could not save the draft for ${sessionId}; keeping it in memory`, error)
  }
}

export function clearDraft(sessionId: string): void {
  const timer = timers.get(sessionId)
  if (timer) clearTimeout(timer)
  timers.delete(sessionId)
  memory.delete(sessionId)
  removeKey(key(sessionId))
}
