import type { TargetAndTransition, Variants } from 'motion/react'
import { prefersReducedMotion } from '@renderer/stores/settings'
import { useSessionsStore } from '@renderer/stores/sessions'

/** --ease-out-quint and --ease-standard. */
const EASE_OUT = [0.22, 1, 0.36, 1] as const
const EASE_STANDARD = [0.2, 0.8, 0.2, 1] as const

/** How long an action's mark waits for its row to leave or come back. */
const MARK_MS = 3_000

/** Rows turned to dust, by session, with how long the sweep takes to pass them. */
const dust = new Map<string, { at: number; sweepMs: number }>()
/** Sessions that Undo brings back, by when. */
const returning = new Map<string, number>()

const fresh = (at: number | undefined): boolean =>
  at !== undefined && performance.now() - at < MARK_MS

/** These rows already turned to dust; their space closes once the sweep has passed them. */
export function markDust(ids: readonly string[], sweepMs: number): void {
  const at = performance.now()
  for (const id of ids) dust.set(id, { at, sweepMs })
  setTimeout(() => {
    for (const id of ids) if (dust.get(id)?.at === at) dust.delete(id)
  }, MARK_MS)
}

export function unmarkDust(ids: readonly string[]): void {
  for (const id of ids) dust.delete(id)
}

/** Undo brings these sessions back, so their rows come back with a fade. */
export function markReturning(ids: readonly string[]): void {
  const at = performance.now()
  for (const id of ids) returning.set(id, at)
  setTimeout(() => {
    for (const id of ids) if (returning.get(id) === at) returning.delete(id)
  }, MARK_MS)
}

// --duration-fast to fade and slide out, then --duration-base to close the space.
const QUIET: TargetAndTransition = {
  opacity: 0,
  x: -12,
  height: 0,
  pointerEvents: 'none',
  transition: {
    opacity: { duration: 0.15, ease: EASE_OUT },
    x: { duration: 0.15, ease: EASE_OUT },
    height: { duration: 0.18, delay: 0.15, ease: EASE_STANDARD },
  },
}

const FADE: TargetAndTransition = {
  opacity: 0,
  height: 0,
  pointerEvents: 'none',
  transition: { opacity: { duration: 0.15 }, height: { duration: 0, delay: 0.15 } },
}

const AT_ONCE: TargetAndTransition = { transition: { duration: 0 } }

/**
 * How a session's row leaves, decided as it leaves: after its dust, quietly when its session was
 * archived or deleted, and at once when it only moved or was filtered out.
 */
function exitOf(sessionId: string): TargetAndTransition {
  const turned = dust.get(sessionId)
  if (turned && fresh(turned.at)) {
    const passed = (performance.now() - turned.at) / 1000
    return {
      height: 0,
      pointerEvents: 'none',
      transition: {
        height: {
          duration: 0.2,
          delay: Math.max(0, turned.sweepMs / 1000 - passed),
          ease: EASE_STANDARD,
        },
      },
    }
  }
  const summary = useSessionsStore.getState().byId[sessionId]
  if (summary && !summary.archivedAt) return AT_ONCE
  return prefersReducedMotion() ? FADE : QUIET
}

/** A session row's variants: `exit` as above, and `hidden` for a row Undo brings back. */
export function rowVariants(sessionId: string): Variants {
  return {
    hidden: { opacity: 0, y: 4 },
    shown: { opacity: 1, y: 0, transition: { duration: 0.18, ease: EASE_OUT } },
    exit: () => exitOf(sessionId),
  }
}

export function isReturning(sessionId: string): boolean {
  return fresh(returning.get(sessionId))
}
