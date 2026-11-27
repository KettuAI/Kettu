import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { ThreadEntry, ThreadState } from '@shared/thread'
import { loadOlder, useThreadsStore } from '@renderer/stores/threads'
import type { ComposerEditorHandle } from './editor'

/** Where the message in the box sits among the session's sent messages. */
export interface InputHistoryPosition {
  /** From 1, the oldest. */
  index: number
  count: number
}

interface Recalled extends InputHistoryPosition {
  id: string
  text: string
}

interface Browsing {
  id: string
  /** What the box held before the first Up, put back on leaving. */
  draft: string
}

/** The message's text when it can be recalled: sent by the user, with something to type. */
function recallable(entry: ThreadEntry | undefined): string | null {
  if (entry?.kind !== 'user' || entry.from || entry.approval || entry.kettu) return null
  const text = entry.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
  return text.trim() ? text : null
}

function recalled(state: ThreadState, id: string): Recalled | null {
  const text = recallable(state.byId[id])
  if (text === null) return null
  let index = 0
  let count = 0
  for (const key of state.order) {
    if (recallable(state.byId[key]) === null) continue
    count += 1
    if (key === id) index = count
  }
  return index === 0 ? null : { id, text, index, count }
}

/**
 * Whether Up (`forward = false`) or Down (`forward = true`) should navigate input history instead
 * of letting the editor move the caret.
 *
 * Outside history browsing, Down never hijacks moving to the line end and Up only enters history
 * from a collapsed single caret at offset 0 (which also holds when the box is empty), so pressing
 * Up mid-line or at the end of the first line moves the caret to the start first. While already
 * browsing history, Up on the first visual line and Down on the last visual line keep stepping
 * across entries.
 */
export function canMoveInputHistory({
  forward,
  browsing,
  selection,
  atBoundary,
}: {
  forward: boolean
  browsing: boolean
  selection: { from: number; to: number }
  atBoundary: boolean
}): boolean {
  if (!atBoundary || selection.from !== selection.to) return false
  if (!browsing) return !forward && selection.from === 0
  return true
}

/**
 * Browsing a session's sent messages from its composer. Up from an empty box or offset 0 puts the
 * newest message in the box; while browsing, Up on the first visual line and Down on the last
 * visual line step through older and newer messages, and past the newest (or on `leave`) the draft
 * comes back. Outside browsing, Up from non-zero offsets and Down stay with the editor. Typing in a
 * recalled message ends the browsing and the text stays as an ordinary draft, so `close` is the
 * box's cue that it was edited.
 */
export function useInputHistory({
  sessionId,
  disabled,
  editor,
  onRecall,
  onError,
}: {
  sessionId: string | null
  disabled: boolean
  editor: RefObject<ComposerEditorHandle | null>
  /** Puts `text` in the box, a message or the draft it replaced; it is not the draft to save. */
  onRecall: (text: string) => void
  onError: () => void
}) {
  const [position, setPosition] = useState<InputHistoryPosition | null>(null)
  const browsing = useRef<Browsing | null>(null)
  const pending = useRef(false)
  const generation = useRef(0)
  const close = useCallback(() => {
    browsing.current = null
    pending.current = false
    generation.current++
    setPosition(null)
  }, [])

  useEffect(() => close, [close, sessionId, disabled])

  /** Ends the browsing and puts the draft back. */
  const leave = () => {
    const current = browsing.current
    close()
    if (current) onRecall(current.draft)
  }

  const move = (forward: boolean): boolean => {
    const input = editor.current
    if (!sessionId || disabled || !input) return false
    const current = browsing.current
    const selection = input.selection()
    if (
      !canMoveInputHistory({
        forward,
        browsing: current !== null,
        selection,
        atBoundary: input.atBoundary(forward),
      })
    ) {
      if (forward && pending.current) {
        pending.current = false
        generation.current++
      }
      return false
    }
    if (pending.current && !forward) return true
    pending.current = false
    const request = ++generation.current
    const text = input.text()
    const focused = document.activeElement

    const seek = (): boolean => {
      const replica = useThreadsStore.getState().replicas[sessionId]
      const state = replica?.state
      if (!state) return false
      const at = current ? state.order.indexOf(current.id) : state.order.length
      if (at < 0) {
        close()
        return false
      }
      for (
        let i = at + (forward ? 1 : -1);
        i >= 0 && i < state.order.length;
        i += forward ? 1 : -1
      ) {
        const next = recalled(state, state.order[i]!)
        if (!next) continue
        browsing.current = { id: next.id, draft: current?.draft ?? text }
        setPosition({ index: next.index, count: next.count })
        onRecall(next.text)
        return true
      }
      if (forward) {
        if (!current) return false
        leave()
        return true
      }
      if (replica.older === null) return current !== null
      const page = loadOlder(sessionId)
      if (!page) return false
      pending.current = true
      void page.then((loaded) => {
        if (request !== generation.current) return
        pending.current = false
        const now = input.selection()
        // A delayed page must not replace text the user typed or a selection they moved.
        if (
          editor.current !== input ||
          input.text() !== text ||
          now.from !== selection.from ||
          now.to !== selection.to ||
          document.activeElement !== focused
        )
          return
        if (loaded) seek()
        else onError()
      })
      return true
    }

    return seek()
  }

  return { position, move, close, leave }
}
