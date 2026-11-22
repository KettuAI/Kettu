// The reading size, one rule for an opened frame and for presenting: what to read is as wide as
// the room allows up to its own size, and shrinks a little more to show its whole height, but a
// long one keeps its width and scrolls instead of shrinking until its text cannot be read.

import type { FitMode } from '@renderer/stores/artifact-viewer'

export interface Room {
  x: number
  y: number
  width: number
  height: number
}

export interface Reading {
  /** The scale the frame shows at. */
  z: number
  /** Where its top left lies on screen. */
  x: number
  y: number
  /** It is taller than the room at this scale, so it scrolls from its top. */
  long: boolean
}

/** Frames up to this wide are phone wide: their type is large, so they may shrink further. */
const PHONE_WIDTH = 520
/** The most the height may cost of the reading size, by how wide the frame is. */
const SHRINK = 0.2
const PHONE_SHRINK = 0.4

/** The scale and place of a `width` by `height` frame in `room`, as `fit` sizes it. */
export function readingFit(
  frame: { width: number; height: number },
  room: Room,
  fit: FitMode,
): Reading {
  const across = room.width / frame.width
  const down = room.height / frame.height
  const byWidth = Math.min(1, across)
  let z: number
  switch (fit) {
    case 'auto': {
      const whole = Math.min(byWidth, down)
      const floor = byWidth * (1 - (frame.width <= PHONE_WIDTH ? PHONE_SHRINK : SHRINK))
      z = whole >= floor ? whole : byWidth
      break
    }
    case 'screen':
      z = Math.min(across, down)
      break
    case 'width':
      z = across
      break
    case 'actual':
      z = 1
  }
  const long = frame.height * z > room.height + 0.5
  return {
    z,
    x: room.x + (room.width - frame.width * z) / 2,
    y: long ? room.y : room.y + (room.height - frame.height * z) / 2,
    long,
  }
}
