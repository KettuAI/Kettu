import type { CSSProperties } from 'react'
import type { TurnPhase } from './turn-phase'

export type RunningPhase = Exclude<TurnPhase['phase'], 'approval'>

/** A dot's keyframes in globals.css, and where in the loop it starts, from 0 to 1. */
interface Dot {
  name: string | null
  at: number
}

interface Pattern {
  ms: number
  easing: string
  dot: (x: number, y: number) => Dot
}

const STILL: Dot = { name: null, at: 0 }

// Each dot's place on the edge, clockwise from the top left, by row; the centre is not on it.
const RING = [0, 1, 2, 7, -1, 3, 6, 5, 4]
// When in the loop each dot twinkles, scattered so no order shows.
const TWINKLE = [0, 0.53, 0.21, 0.78, 0.37, 0.91, 0.12, 0.66, 0.45]

const trail = (at: number): Dot => ({ name: 'turn-dot-trail', at })
const fromCentre = (x: number, y: number) => Math.hypot(x - 1, y - 1)

const PATTERNS = {
  chase: {
    ms: 960,
    easing: 'linear',
    dot: (x, y) => {
      const place = RING[y * 3 + x]!
      return place < 0 ? STILL : trail(place / 8)
    },
  },
  think: {
    ms: 2000,
    easing: 'ease-in-out',
    dot: (x, y) => ({ name: 'turn-dot-twinkle', at: (1 - TWINKLE[y * 3 + x]!) % 1 }),
  },
  read: { ms: 1500, easing: 'linear', dot: (x, y) => trail((y * 1.2 + x * 0.3) / 3.6) },
  search: {
    ms: 1600,
    easing: 'linear',
    dot: (x) =>
      x === 1 ? { name: 'turn-dot-sweep-mid', at: 0 } : { name: 'turn-dot-sweep-edge', at: x / 4 },
  },
  edit: {
    ms: 1400,
    easing: 'ease-in-out',
    dot: (x, y) => ({ name: 'turn-dot-swap', at: (x + y) % 2 ? 0.5 : 0 }),
  },
  fetch: { ms: 1200, easing: 'linear', dot: (x, y) => trail(fromCentre(x, y) / 2.6) },
  compact: {
    ms: 1200,
    easing: 'linear',
    dot: (x, y) => trail((Math.SQRT2 - fromCentre(x, y)) / 2.6),
  },
  write: {
    ms: 1800,
    easing: 'linear',
    dot: (x, y) => ({ name: 'turn-dot-fill', at: (y * 3 + x) * 0.05 }),
  },
} satisfies Record<string, Pattern>

export const BY_PHASE: Record<RunningPhase, keyof typeof PATTERNS> = {
  thinking: 'think',
  execute: 'chase',
  read: 'read',
  search: 'search',
  fetch: 'fetch',
  edit: 'edit',
  writing: 'write',
  compacting: 'compact',
  working: 'chase',
}

/** The grid's cells by row, as [x, y]. */
export const CELLS = [0, 1, 2].flatMap((y) => [0, 1, 2].map((x) => [x, y] as const))

/** Each cell's style for the phase, in CELLS order: its animation, or none for a still dot. */
export function turnDotStyles(phase: RunningPhase): (CSSProperties | undefined)[] {
  const pattern: Pattern = PATTERNS[BY_PHASE[phase]]
  return CELLS.map(([x, y]) => {
    const dot = pattern.dot(x, y)
    // A negative delay starts the dot partway into the loop, so every dot is in step at once.
    const delay = Math.round((dot.at - 1) * pattern.ms)
    return dot.name
      ? { animation: `${dot.name} ${pattern.ms}ms ${pattern.easing} ${delay}ms infinite` }
      : undefined
  })
}
