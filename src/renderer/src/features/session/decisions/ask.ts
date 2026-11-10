import type { TFunction } from 'i18next'
import { useShallow } from 'zustand/react/shallow'
import type { ThreadEntry } from '@shared/thread'
import type { Decision, DecisionAnswer } from '@renderer/components/affect/decision-card'
import { useThreadsStore } from '@renderer/stores/threads'

/** One page of the Decision Card above the composer, and what its answer does. */
export interface Ask {
  /** Stable while it waits; the card's id adds the group's attempt. */
  key: string
  /** The asks answered together, such as an ask's questions, which come back together. */
  group: string
  decision: Omit<Decision, 'id'>
  answer: (answer: DecisionAnswer) => void
}

export interface AskContext {
  t: TFunction<'session'>
  sessionId: string
  agentName: string
  projectPath: string
  /** Sends an answer; when it does not go, the group's pages come back and the error shows. */
  go: (group: string, request: () => Promise<void>) => Promise<boolean>
  /** Queues the user's words as their next message. */
  say: (text: string) => Promise<void>
  /** State an ask keeps while it waits, such as a form's values, under a key of its own. */
  state: <T>(key: string, initial: T) => [T, (next: T) => void]
}

const EMPTY: ThreadEntry[] = []

/** Whether the entry waits for the user's answer. */
function waits(entry: ThreadEntry): boolean {
  switch (entry.kind) {
    case 'tool':
      return !!entry.permission
    case 'browser_origin':
    case 'computer_app':
    case 'device_access':
    case 'project_mcp':
      return entry.decision === null
    default:
      return false
  }
}

/** The session's entries that wait for the user, oldest first. */
export function useWaiting(sessionId: string): ThreadEntry[] {
  return useThreadsStore(
    useShallow((s) => {
      const state = s.replicas[sessionId]?.state
      if (!state) return EMPTY
      const out: ThreadEntry[] = []
      for (const id of state.order) {
        const entry = state.byId[id]
        if (entry && waits(entry)) out.push(entry)
      }
      return out.length > 0 ? out : EMPTY
    }),
  )
}
