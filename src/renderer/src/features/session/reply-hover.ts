import { create } from 'zustand'

/** The reply the pointer is over, by its footer's key, so only that footer shows its actions. */
export const useReplyHover = create<{ key: string | null }>(() => ({ key: null }))

export function hoverReply(key: string | null): void {
  if (useReplyHover.getState().key !== key) useReplyHover.setState({ key })
}
