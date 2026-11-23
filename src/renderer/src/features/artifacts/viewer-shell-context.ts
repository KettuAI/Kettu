import { createContext, useContext } from 'react'

/**
 * How much room the viewer has, by its own width and nothing else: wide keeps labels and both
 * cards, middle shows one card at a time, narrow lays the cards over the content or under it.
 */
export type Tier = 'wide' | 'middle' | 'narrow'

export function tierOf(width: number): Tier {
  return width >= 960 ? 'wide' : width >= 640 ? 'middle' : 'narrow'
}

/** Under this width the bar folds Present, Share and who is here into More. */
export const TIGHT_PX = 480
/**
 * From this width the tools on the bar's right take their words too: below it, with the modes'
 * words and who is here, they would meet the centred modes.
 */
export const LABELLED_PX = 1200
/** The cards' widths and the gap they keep from the edges, in pixels. */
export const LEFT_W = 248
export const RIGHT_W = 320
export const EDGE = 12

/** A place in the shell a kind fills: the left card, its own right card, the dock or the pill. */
export type Slot = 'left' | 'leftHead' | 'right' | 'dock' | 'pill'

/** The room the cards take beside the content, which a canvas keeps clear when it fits. */
export interface Insets {
  left: number
  right: number
}

export interface ShellValue {
  tier: Tier
  tight: boolean
  /** Whether the bar has room for the words of the tools on its right. */
  labelled: boolean
  insets: Insets
  targets: Record<Slot, HTMLElement | null>
  /** The left card, for the dock's button that shows and hides it; null for a kind without one. */
  leftCard: { shown: boolean; setShown: (shown: boolean) => void } | null
}

export const ShellContext = createContext<ShellValue | null>(null)

export const NO_SHELL: ShellValue = {
  tier: 'wide',
  tight: false,
  labelled: true,
  insets: { left: 0, right: 0 },
  targets: { left: null, leftHead: null, right: null, dock: null, pill: null },
  leftCard: null,
}

/** The shell around the content: its width tier, the room its cards take and its slots. */
export function useShell(): ShellValue {
  return useContext(ShellContext) ?? NO_SHELL
}
