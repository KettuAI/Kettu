import { create } from 'zustand'

/** A message of a session that Search or a session report opened it for, until its thread has gone there. */
export interface RevealTarget {
  sessionId: string
  entryId: string
  pos: number | null
}

/** A target nobody took within this long is dropped, so a session that never opened is not jumped in later. */
export const REVEAL_TTL_MS = 10_000

export const useRevealStore = create<{ target: (RevealTarget & { at: number }) | null }>()(() => ({
  target: null,
}))

export function revealMessage(target: RevealTarget): void {
  useRevealStore.setState({ target: { ...target, at: Date.now() } })
}
