// Where each card of the queue stack sits, in px from its resting place behind the composer.
// Folded, the next message shows with up to two edges peeking above it; fanned out, three cards
// show in full, an edge above them says more wait, and the offset moves through the queue: a
// card the offset passes slides back down behind the composer.

/** A card's height; its lower part stays behind the composer. */
export const CARD = 44
/** How much of a card shows above the one in front of it, or above the composer. */
export const STEP = 36
/** How much of a folded card shows above the one in front of it. */
const PEEK = 6
/** How much of the card past the third shows above it while fanned out. */
const EDGE = 6
/** How far a card slides down behind the composer as it leaves the front. */
export const BEHIND = 18

export interface CardPose {
  y: number
  scale: number
  opacity: number
  /** The card's text, which only the front cards show. */
  content: number
  /** 0 at the front, 1 three cards back: how far the card's fill has faded toward the back. */
  depth: number
  z: number
  /** Whether it takes the pointer. */
  interactive: boolean
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export function foldedPose(index: number): CardPose {
  const d = Math.min(index, 2)
  return {
    y: -PEEK * d,
    scale: 1 - 0.04 * d,
    opacity: index < 3 ? 1 : 0,
    content: index === 0 ? 1 : 0,
    depth: d / 2,
    z: 30 - index,
    interactive: index < 3,
  }
}

/** A fanned-out card, `offset` cards into the queue: the card at the offset is at the front. */
export function openPose(index: number, offset: number): CardPose {
  const r = index - offset
  return {
    ...place(r),
    depth: clamp(r / 3, 0, 1),
    z: 100 - Math.round(r * 10),
    interactive: r > -0.5 && r < 2.5,
  }
}

/** A fanned-out card `r` cards behind the front, negative once the offset has passed it. */
function place(r: number): Pick<CardPose, 'y' | 'scale' | 'opacity' | 'content'> {
  if (r < -1) return { y: BEHIND, scale: 0.97, opacity: 0, content: 0 }
  if (r < 0) {
    const t = r + 1
    return { y: lerp(BEHIND, 0, t), scale: lerp(0.97, 1, t), opacity: t, content: t }
  }
  if (r <= 2) {
    return { y: -STEP * r, scale: 1 - 0.03 * r, opacity: 1, content: r <= 1 ? 1 : 1.2 - 0.2 * r }
  }
  if (r <= 3) {
    const t = r - 2
    return { y: -2 * STEP - EDGE * t, scale: 0.94 - 0.03 * t, opacity: 1, content: 0.8 * (1 - t) }
  }
  return { y: -2 * STEP - EDGE, scale: 0.91, opacity: clamp(4 - r, 0, 1), content: 0 }
}

/** The height the stack takes from the cards above the composer, `count` > 0. */
export function stackHeight(count: number, open: boolean): number {
  const behind = count - 1
  if (!open) return CARD + PEEK * Math.min(behind, 2)
  return CARD + (behind <= 2 ? STEP * behind : 2 * STEP + EDGE)
}

/** The room the folded stack keeps above the composer, so it never covers what is above it. */
export function reserveHeight(count: number): number {
  return STEP + PEEK * Math.min(count - 1, 2)
}

/** The offset while it follows the wheel, a quarter card past either end so the ends give. */
export function clampOffset(offset: number, count: number): number {
  return clamp(offset, -0.25, count - 1 + 0.25)
}

/** The card the offset settles on once the wheel stops. */
export function snapOffset(offset: number, count: number): number {
  return clamp(Math.round(offset), 0, Math.max(0, count - 1))
}

/**
 * The cards to render, [start, end): those that can show at this offset and one on either side,
 * so a card enters and leaves the tree only where it is invisible.
 */
export function shownRange(count: number, open: boolean, offset: number): [number, number] {
  if (!open) return [0, Math.min(count, 3)]
  return [Math.max(0, Math.floor(offset) - 1), Math.min(count, Math.ceil(offset) + 5)]
}

/**
 * The card that shows its actions, or -1: once fanned out and settled, the one under the pointer
 * when it is one of the three in front, else the front one while the stack has keyboard focus.
 */
export function actionCard({
  open,
  following,
  front,
  hovered,
  keyboard,
}: {
  open: boolean
  following: boolean
  front: number
  hovered: number
  keyboard: boolean
}): number {
  if (!open || following) return -1
  if (hovered >= front && hovered <= front + 2) return hovered
  return keyboard ? front : -1
}
