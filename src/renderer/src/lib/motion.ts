import type { CSSProperties } from 'react'
import type { Transition } from 'motion/react'

/** Springs from the design system: stiffness / damping / mass. */
export const springs = {
  card: { type: 'spring', stiffness: 320, damping: 28, mass: 1 },
  panel: { type: 'spring', stiffness: 1200, damping: 80, mass: 0.1 },
} satisfies Record<string, Transition>

/** Motion exit for dismissed alerts and banners: opacity at --duration-fast. */
export const fadeExit = { opacity: 0, transition: { duration: 0.12 } }

/** What follows the pointer or the wheel: --duration-fast and --ease-out-quart. */
export const follow = {
  type: 'tween',
  duration: 0.12,
  ease: [0.165, 0.84, 0.44, 1],
} satisfies Transition

/** Staggered entry: once, the first item after `base` ms and each next one 30 ms later. */
export function rise(index: number, base = 60): { className: string; style: CSSProperties } {
  return {
    className:
      'animate-in fade-in slide-in-from-bottom-1 fill-mode-both animation-duration-(--duration-slow) ease-out-quint',
    style: { animationDelay: `${base + index * 30}ms` },
  }
}
