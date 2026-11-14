// The windows main draws while a session uses the computer and Kettu is in the background: the
// light and the agent's pointer around the real window, and the label at the top of the screen.

import type { ComputerAct, ComputerControl } from './computer-use'
import type { KettuApi } from './ipc'
import type { Locale } from './locale'

/** Which of the two windows a page is. */
export type ComputerOverlayPart = 'light' | 'label'

/** What a page draws, which main sends whole whenever any of it changes. */
export interface ComputerOverlayState {
  agentId: string
  agentName: string
  /** The app it uses; null before its first. */
  app: string | null
  /** The app's icon as a data URL; null until main has read it, or when it has none. */
  appIcon: string | null
  control: ComputerControl
  act: ComputerAct | null
  /** The stop shortcut as an Electron accelerator. */
  shortcut: string
  dark: boolean
  reduceMotion: boolean
  locale: Locale
  /**
   * The light's window: the real window's size in points and the room around it the light takes.
   * Inside draws the light along the window's inner edges, for one that fills its screen.
   */
  frame: { width: number; height: number; pad: number; inside: boolean } | null
}

/** A label button. */
export type ComputerOverlayAction = 'take-over' | 'hand-back' | 'stop'

export function isComputerOverlayAction(value: unknown): value is ComputerOverlayAction {
  return value === 'take-over' || value === 'hand-back' || value === 'stop'
}

/** What the overlay preload exposes as window.kettu. */
export interface ComputerOverlayApi {
  platform: KettuApi['platform']
  client: 'desktop'
  systemLocale: Locale
  part: ComputerOverlayPart
  onState(listener: (state: ComputerOverlayState) => void): () => void
  act(action: ComputerOverlayAction): void
  /** The label's size in CSS pixels, which its window takes. */
  resize(width: number, height: number): void
}

export const OVERLAY_CHANNELS = {
  state: 'computer-overlay:state',
  action: 'computer-overlay:action',
  resize: 'computer-overlay:resize',
} as const
