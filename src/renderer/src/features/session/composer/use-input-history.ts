import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { ThreadEntry, ThreadState } from '@shared/thread'
import { loadOlder, useThreadsStore } from '@renderer/stores/threads'
import type { ComposerEditorHandle } from './editor'

/** A sent message the card shows, and where it sits among the session's sent messages. */
export interface InputHistoryEntry {
  id: string
  text: string
  /** The message's place among the recallable messages, from 1. */
  index: number
  count: number
}

/** The message's text when it can be recalled: sent by the user, with something to type. */
function recallable(entry: ThreadEntry | undefined): string | null {
  if (entry?.kind !== 'user' || entry.from) return null
  const text = entry.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
  return text.trim() ? text : null
}

function entryOf(state: ThreadState, id: string): InputHistoryEntry | null {
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
 * Browsing a session's sent messages from its composer. Up opens the card on the newest message
 * once the caret is on the box's first line; while it is open the card takes both arrows. The
 * composer's draft is never touched: the card only shows a message until it is inserted.
 */
export function useInputHistory({
  sessionId,
  disabled,
  editor,
  onError,
}: {
  sessionId: string | null
  disabled: boolean
  editor: RefObject<ComposerEditorHandle | null>
  onError: () => void
}) {
  const [entry, setEntry] = useState<InputHistoryEntry | null>(null)
  // The same message as the state, read while a key is handled, before its render.
  const shown = useRef<string | null>(null)
  const pending = useRef(false)
  const generation = useRef(0)
  const close = useCallback(() => {
    shown.current = null
    pending.current = false
    generation.current++
    setEntry(null)
  }, [])

  useEffect(() => close, [close, sessionId, disabled])

  const move = (forward: boolean): boolean => {
    if (!sessionId || disabled) return false
    if (shown.current === null && (forward || !editor.current?.atBoundary(false))) return false
    if (pending.current && !forward) return true
    pending.current = false
    const request = ++generation.current
    const from = shown.current
    const input = editor.current
    const text = input?.text() ?? ''
    const selection = input?.selection()
    const focused = document.activeElement

    const seek = (): boolean => {
      const replica = useThreadsStore.getState().replicas[sessionId]
      const state = replica?.state
      if (!state) return false
      const at = from === null ? state.order.length : state.order.indexOf(from)
      if (at < 0) {
        close()
        return false
      }
      for (
        let i = at + (forward ? 1 : -1);
        i >= 0 && i < state.order.length;
        i += forward ? 1 : -1
      ) {
        const next = entryOf(state, state.order[i]!)
        if (!next) continue
        shown.current = next.id
        setEntry(next)
        return true
      }
      if (forward) {
        if (from === null) return false
        // Past the newest message the card closes, leaving the draft as it was.
        close()
        return true
      }
      if (replica.older === null) return from !== null
      const page = loadOlder(sessionId)
      if (!page) return false
      pending.current = true
      void page.then((loaded) => {
        if (request !== generation.current) return
        pending.current = false
        const now = editor.current?.selection()
        // A delayed page must not open the card after the user typed or moved the caret.
        if (
          editor.current !== input ||
          (editor.current?.text() ?? '') !== text ||
          now?.from !== selection?.from ||
          now?.to !== selection?.to ||
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

  return { entry, move, close }
}
