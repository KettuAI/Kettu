// Pure keyboard and geometry helpers for the Files pane's selection-anchored note popover.

import { isMod } from '@renderer/lib/platform'

export type NoteSendKey = 'enter' | 'mod-enter'

export type NoteKeyAction = 'send' | 'close' | 'ignore'

export interface AnchorRect {
  left: number
  top: number
  right: number
  bottom: number
}

/**
 * Classifies a keydown event inside the note textarea while guarding against IME composition
 * (both `isComposing` and the legacy WebKit `keyCode === 229` signal).
 */
export function noteKeyAction(
  event: {
    key: string
    shiftKey: boolean
    altKey: boolean
    metaKey: boolean
    ctrlKey: boolean
    isComposing?: boolean
    keyCode?: number
  },
  sendKey: NoteSendKey,
): NoteKeyAction {
  if (event.isComposing || event.keyCode === 229) return 'ignore'
  if (event.key === 'Escape') return 'close'
  if (event.key !== 'Enter') return 'ignore'
  if (sendKey === 'enter') {
    if (!event.shiftKey && !event.altKey) return 'send'
    return 'ignore'
  }
  return isMod(event) && !event.altKey ? 'send' : 'ignore'
}

/** Clamps a selection rect into its scroll container bounds so the popover never clips off-pane. */
export function clampRectToBounds(rect: AnchorRect, bounds: AnchorRect): AnchorRect {
  const minLeft = bounds.left
  const maxRight = Math.max(bounds.left, bounds.right)
  const minTop = bounds.top
  const maxBottom = Math.max(bounds.top, bounds.bottom)
  const left = Math.min(Math.max(rect.left, minLeft), maxRight)
  const right = Math.min(Math.max(rect.right, left), maxRight)
  const top = Math.min(Math.max(rect.top, minTop), maxBottom)
  const bottom = Math.min(Math.max(rect.bottom, top), maxBottom)
  return { left, top, right, bottom }
}

/** True while any part of `rect` intersects `bounds`. */
export function isRectVisibleInBounds(rect: AnchorRect, bounds: AnchorRect): boolean {
  return (
    rect.bottom > bounds.top &&
    rect.top < bounds.bottom &&
    rect.right > bounds.left &&
    rect.left < bounds.right
  )
}
