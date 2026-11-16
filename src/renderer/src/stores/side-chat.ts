import { create } from 'zustand'
import type { AgentId } from '@shared/thread'
import { host } from '@renderer/lib/host'
import { toggleSideChat, useViewStore } from '@renderer/stores/view'

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
}

export const useSideChatStore = create<SideChatStore>(() => ({ drafts: {}, focus: {} }))

const EMPTY: SideDraft = { text: '', quote: null }

export function sideDraft(sessionId: string): SideDraft {
  return useSideChatStore.getState().drafts[sessionId] ?? EMPTY
}

export function setSideDraft(sessionId: string, changes: Partial<SideDraft>): void {
  useSideChatStore.setState((s) => ({
    drafts: { ...s.drafts, [sessionId]: { ...(s.drafts[sessionId] ?? EMPTY), ...changes } },
  }))
}

/** Opens a session's side chat with the focus in its input, a passage quoted when given. */
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
 * Mod+J: opens the side chat, moves the focus into it when it is open elsewhere, and closes it
 * when the focus is already in it.
 */
export function toggleSideChatFocus(sessionId: string, focused: boolean): void {
  const open = !!useViewStore.getState().sideChatOpen[sessionId]
  if (open && focused) toggleSideChat(sessionId, false)
  else openSideChat(sessionId)
}

/** Asks a side question; the answer arrives with the session's view. */
export function askSide(
  sessionId: string,
  question: string,
  quote: string | null,
  agentId?: AgentId,
): Promise<void> {
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
