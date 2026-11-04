import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { loadOlder, useThreadsStore } from '@renderer/stores/threads'
import type { ComposerEditorHandle } from './editor'

interface Browsing {
  id: string
  draft: string
  edits: Map<string, string>
}

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
  onRecall: (text: string) => void
  onError: () => void
}) {
  const browsing = useRef<Browsing | null>(null)
  const pending = useRef(false)
  const generation = useRef(0)
  const reset = useCallback(() => {
    browsing.current = null
    pending.current = false
    generation.current++
  }, [])

  useEffect(() => reset, [reset, sessionId, disabled])

  const move = (forward: boolean): boolean => {
    const input = editor.current
    if (!sessionId || disabled || !input?.atBoundary(forward)) return false
    if (pending.current && !forward) return true
    pending.current = false
    const request = ++generation.current
    const text = input.text()
    const selection = input.selection()
    const focused = document.activeElement
    const current = browsing.current
    if (current) current.edits.set(current.id, text)

    const seek = (): boolean => {
      const replica = useThreadsStore.getState().replicas[sessionId]
      const state = replica?.state
      if (!state) return false
      const at = current ? state.order.indexOf(current.id) : state.order.length
      if (at < 0) {
        reset()
        return false
      }
      for (
        let i = at + (forward ? 1 : -1);
        i >= 0 && i < state.order.length;
        i += forward ? 1 : -1
      ) {
        const entry = state.byId[state.order[i]!]
        if (entry?.kind !== 'user' || entry.from) continue
        const original = entry.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('\n')
        if (!original.trim()) continue
        const next = current ?? { id: entry.id, draft: text, edits: new Map<string, string>() }
        next.id = entry.id
        browsing.current = next
        onRecall(next.edits.get(entry.id) ?? original)
        return true
      }
      if (forward) {
        if (!current) return false
        browsing.current = null
        onRecall(current.draft)
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

  return { move, reset }
}
