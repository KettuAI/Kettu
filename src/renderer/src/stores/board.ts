import { create } from 'zustand'

interface BoardStore {
  /** By session id: the live items the board's button has counted as seen. */
  seen: Record<string, readonly string[]>
}

export const useBoardStore = create<BoardStore>(() => ({ seen: {} }))
