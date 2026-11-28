import type { RunningSend } from '@shared/settings'
import type { QueuedPrompt, SessionStatus } from '@shared/thread'
import { composerRunState } from './composer/composer-state'

/** Minimal keyboard event shape needed to detect the empty-composer queue send-now shortcut. */
export interface QueueSendNowKeyEvent {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  isComposing?: boolean
  keyCode?: number
  repeat?: boolean
}

export interface QueueSendNowShortcutSettings {
  sendKey: 'enter' | 'mod-enter'
  runningSend: RunningSend
  /** Platform modifier flag (`true` on macOS for Cmd, `false` on Windows/Linux for Ctrl). */
  mac: boolean
}

export interface EmptyComposerQueueSendInput extends QueueSendNowShortcutSettings {
  event: QueueSendNowKeyEvent
  status: SessionStatus
  waitingBackground?: boolean
  queue: readonly QueuedPrompt[]
  /** Whether the composer holds any non-whitespace text, attachment, chip, comment, or selection. */
  holdsMessage: boolean
  disabled?: boolean
  heldOutside?: boolean
  mustSwitch?: boolean
  pendingSwitch?: boolean
  activeDelegate?: boolean
  editingSuggestion?: boolean
  hasWaitingCard?: boolean
  popoverOpen?: boolean
  /** Item id currently in flight for this session's `sessions.sendNow` RPC, if any. */
  inFlightItemId?: string | null
}

/**
 * Whether a queued entry is a sendable prompt eligible for immediate Send now / steer.
 * Child session completion reports (`from.ended`), Kettu internal reminders (`kettu`),
 * card approval answers (`approval`), and empty entries are excluded.
 */
export function isQueuedPromptSendable(item: QueuedPrompt): boolean {
  if (item.from?.ended) return false
  if (item.kettu || item.approval) return false
  return item.content.length > 0
}

/** Returns the first queued entry eligible for immediate Send now / steer, or null. */
export function firstSendableQueuedPrompt(queue: readonly QueuedPrompt[]): QueuedPrompt | null {
  return queue.find(isQueuedPromptSendable) ?? null
}

/**
 * Whether `event` is the empty-composer shortcut for sending/steering the first eligible queued
 * message:
 * - `Cmd+Enter` (macOS) / `Ctrl+Enter` (Windows/Linux) across all send settings.
 * - `Cmd+Shift+Enter` / `Ctrl+Shift+Enter` additionally when `sendKey === 'mod-enter'` and
 *   `runningSend === 'queue'`, where that combination is the active immediate-send shortcut.
 */
export function isQueueSendNowShortcut(
  event: QueueSendNowKeyEvent,
  { sendKey, runningSend, mac }: QueueSendNowShortcutSettings,
): boolean {
  if (event.key !== 'Enter') return false
  if (event.isComposing || event.keyCode === 229 || event.repeat || event.altKey) return false
  const mod = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  if (!mod) return false
  if (!event.shiftKey) return true
  return sendKey === 'mod-enter' && runningSend === 'queue'
}

/**
 * Resolves the queued item to immediately send/steer when the user presses the send-now shortcut
 * in an empty composer, or null when the shortcut does not apply or any guard blocks it.
 */
export function resolveEmptyComposerQueueSend(
  input: EmptyComposerQueueSendInput,
): QueuedPrompt | null {
  if (input.holdsMessage) return null
  if (
    input.disabled ||
    input.heldOutside ||
    input.mustSwitch ||
    input.pendingSwitch ||
    input.activeDelegate ||
    input.editingSuggestion ||
    input.hasWaitingCard ||
    input.popoverOpen ||
    input.inFlightItemId != null
  ) {
    return null
  }
  const run = composerRunState({
    status: input.status,
    waitingBackground: input.waitingBackground,
    heldOutside: input.heldOutside,
  })
  if (!run.activeRunning || run.awaiting) return null
  if (
    !isQueueSendNowShortcut(input.event, {
      sendKey: input.sendKey,
      runningSend: input.runningSend,
      mac: input.mac,
    })
  ) {
    return null
  }
  return firstSendableQueuedPrompt(input.queue)
}

/**
 * Per-session in-flight `sessions.sendNow` tracking shared by Composer shortcuts and QueueStack
 * buttons so rapid double-presses or concurrent clicks cannot double-send the same item or race
 * another queued entry ahead of it while the first RPC is still pending.
 */
const inFlightSendNow = new Map<string, string>()

/** Returns the queued item id currently being sent via `sessions.sendNow` for `sessionId`. */
export function inFlightQueuedSend(sessionId: string): string | null {
  return inFlightSendNow.get(sessionId) ?? null
}

/**
 * Runs a `sessions.sendNow` request if none is currently in flight for `sessionId`.
 * Returns the tracked promise, or null when a send-now request is already pending.
 */
export function runQueuedSendNow(
  sessionId: string,
  itemId: string,
  send: () => Promise<unknown>,
): Promise<void> | null {
  if (inFlightSendNow.has(sessionId)) return null
  inFlightSendNow.set(sessionId, itemId)
  let pending: Promise<unknown>
  try {
    pending = send()
  } catch (error) {
    if (inFlightSendNow.get(sessionId) === itemId) {
      inFlightSendNow.delete(sessionId)
    }
    return Promise.reject(error)
  }
  const release = () => {
    if (inFlightSendNow.get(sessionId) === itemId) {
      inFlightSendNow.delete(sessionId)
    }
  }
  return Promise.resolve(pending).then(
    () => {
      release()
    },
    (error: unknown) => {
      release()
      throw error
    },
  )
}
