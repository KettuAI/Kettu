import { createContext, useContext } from 'react'
import type { PaneView } from './layout'

/** The pane a component sits in, which reads its own view rather than the main area's. */
export interface PaneContextValue {
  paneId: string
  view: PaneView
  /** Whether this is the pane in focus, the one the keys and the side panel act for. */
  focused: boolean
  /** The top pane of the first column in view, which leaves room for the traffic lights. */
  cornered: boolean
  /** Whether the main area shows more than one pane, which draws marks and a Close pane. */
  split: boolean
}

export const PaneContext = createContext<PaneContextValue | null>(null)

/** The pane around a component; null outside a pane, as in a page. */
export function usePane(): PaneContextValue | null {
  return useContext(PaneContext)
}

/** Whether this component is in the pane in focus; true outside a split. */
export function usePaneFocused(): boolean {
  return useContext(PaneContext)?.focused ?? true
}
