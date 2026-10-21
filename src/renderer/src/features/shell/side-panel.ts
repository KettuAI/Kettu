import { createContext, useContext } from 'react'

/** Whether the side panel is open beside the content, so it, not the top bar, reaches the window's right edge. */
export const SidePanelContext = createContext(false)

export function useBesideSidePanel(): boolean {
  return useContext(SidePanelContext)
}
