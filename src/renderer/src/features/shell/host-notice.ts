// The views on screen that say themselves that the agent host is away, in a place of their own, so
// the window's notice neither says it a second time nor lies over their bar.

import { useEffect } from 'react'
import { create } from 'zustand'

const useHostNoticeStore = create<{ said: number }>()(() => ({ said: 0 }))

/** Counts this view as saying that the agent host is away, while `says`. */
export function useSaysHostAway(says: boolean): void {
  useEffect(() => {
    if (!says) return
    useHostNoticeStore.setState((s) => ({ said: s.said + 1 }))
    return () => useHostNoticeStore.setState((s) => ({ said: s.said - 1 }))
  }, [says])
}

/** Whether a view on screen says it. */
export function useHostAwaySaid(): boolean {
  return useHostNoticeStore((s) => s.said > 0)
}
