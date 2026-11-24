import { useEffect } from 'react'
import { create } from 'zustand'
import type { AgentId, SideChatView } from '@shared/thread'
import { host } from '@renderer/lib/host'
import { useThreadsStore } from '@renderer/stores/threads'
import { closeSidePanel, toggleSideChat, useViewStore } from '@renderer/stores/view'

/** What is being written in a session's side chat: the question and the passage it quotes. */
export interface SideDraft {
  text: string
  quote: string | null
}

interface SideChatStore {
  /** By session id. */
  drafts: Record<string, SideDraft>
  /** Bumped to move the focus into a session's side chat input once it shows. */
  focus: Record<string, number>
  /** By session id: when the newest answer the side chat has shown ended. */
  seen: Record<string, number>
}

export const useSideChatStore = create<SideChatStore>(() => ({ drafts: {}, focus: {}, seen: {} }))

const EMPTY: SideDraft = { text: '', quote: null }

export function sideDraft(sessionId: string): SideDraft {
  return useSideChatStore.getState().drafts[sessionId] ?? EMPTY
}

export function setSideDraft(sessionId: string, changes: Partial<SideDraft>): void {
  useSideChatStore.setState((s) => ({
    drafts: { ...s.drafts, [sessionId]: { ...(s.drafts[sessionId] ?? EMPTY), ...changes } },
  }))
}

/** Selects a session's side chat tab with the focus in its input, a passage quoted when given. */
export function openSideChat(sessionId: string, quote?: string): void {
  toggleSideChat(sessionId, true)
  useSideChatStore.setState((s) => ({
    ...(quote === undefined
      ? {}
      : {
          drafts: {
            ...s.drafts,
            [sessionId]: { ...(s.drafts[sessionId] ?? EMPTY), quote },
          },
        }),
    focus: { ...s.focus, [sessionId]: (s.focus[sessionId] ?? 0) + 1 },
  }))
}

/**
 * Mod+J: selects the side chat's tab and moves the focus into it, and folds the side panel away
 * when the focus is already in it.
 */
export function toggleSideChatFocus(sessionId: string, focused: boolean): void {
  const open = useViewStore.getState().sidePane[sessionId] === 'sideChat'
  if (open && focused) closeSidePanel(sessionId)
  else openSideChat(sessionId)
}

/** When the newest answered or failed side question ended; 0 for none. */
function latestAnswerEnd(side: SideChatView | null | undefined): number {
  let latest = 0
  for (const entry of side?.entries ?? []) {
    if (entry.status === 'answered' || entry.status === 'failed') {
      latest = Math.max(latest, entry.answeredAt ?? 0)
    }
  }
  return latest
}

/**
 * Whether a side question ended while the side chat was not shown, for the dot on its tab. What is
 * there when the mark first shows, and everything while the chat shows, counts as seen.
 */
export function useSideChatNews(sessionId: string | null): boolean {
  const key = sessionId ?? ''
  const latest = useThreadsStore((s) => latestAnswerEnd(s.replicas[key]?.state?.session.sideChat))
  const seen = useSideChatStore((s) => s.seen[key])
  const open = useViewStore((s) => s.sidePane[key] === 'sideChat')
  useEffect(() => {
    if (key !== '' && (open || seen === undefined) && seen !== latest) {
      useSideChatStore.setState((s) => ({ seen: { ...s.seen, [key]: latest } }))
    }
  }, [key, open, seen, latest])
  return !open && seen !== undefined && latest > seen
}

/** Asks a side question; the answer arrives with the session's view. */
export function askSide(
  sessionId: string,
  question: string,
  quote: string | null,
  agentId?: AgentId,
): Promise<void> {
  // What is answered by now counts as seen, so an answer that ends while the chat is closed or
  // the session is elsewhere shows on the button.
  const latest = latestAnswerEnd(
    useThreadsStore.getState().replicas[sessionId]?.state?.session.sideChat,
  )
  useSideChatStore.setState((s) => ({ seen: { ...s.seen, [sessionId]: latest } }))
  return host('sessions.sideAsk', {
    sessionId,
    question,
    ...(quote ? { quote } : {}),
    ...(agentId ? { agentId } : {}),
  })
}

/** The question a composer text that starts with `/btw` asks; null for any other text. */
export function sideQuestionOf(text: string): string | null {
  const match = /^\/btw(?:\s+([\s\S]*))?$/.exec(text.trim())
  return match ? (match[1] ?? '').trim() : null
}
