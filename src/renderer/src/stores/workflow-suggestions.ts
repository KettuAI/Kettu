// The workflow cards of the sessions on screen, as their hosts keep them: read once per session and
// kept current by the hosts' events, so every window and device shows the same answer.

import { create } from 'zustand'
import type { WorkflowSuggestion } from '@shared/workflow'
import { hostAt } from '@renderer/lib/host'

interface SuggestionsStore {
  byId: Record<string, WorkflowSuggestion>
  /** The cards Start was pressed on in this window, which opens their task once it starts. */
  pressed: Record<string, true>
  receive(suggestion: WorkflowSuggestion): void
}

export const useSuggestionsStore = create<SuggestionsStore>()((set) => ({
  byId: {},
  pressed: {},
  receive(suggestion) {
    set((state) => ({ byId: { ...state.byId, [suggestion.id]: suggestion } }))
  },
}))

/** Sessions whose cards were read or are being read. */
const read = new Set<string>()

function load(sessionId: string, hostId: string | null): void {
  const key = `${hostId ?? ''}/${sessionId}`
  if (read.has(key)) return
  read.add(key)
  hostAt(hostId, 'workflows.suggestions', { sessionId }).then(
    (suggestions) => {
      useSuggestionsStore.setState((state) => {
        const byId = { ...state.byId }
        // An event may have brought a newer copy while the read was on its way.
        for (const s of suggestions) byId[s.id] ??= s
        return { byId }
      })
    },
    () => read.delete(key),
  )
}

/** The card with this id, read with its session's cards the first time it is asked for. */
export function useSuggestion(
  id: string | null,
  sessionId: string,
  hostId: string | null,
): WorkflowSuggestion | null {
  const own = useSuggestionsStore((s) => (id ? (s.byId[id] ?? null) : null))
  if (id && !own) queueMicrotask(() => load(sessionId, hostId))
  return own
}
