import type { PlanItem, ThreadState } from '@shared/thread'
import { useThreadsStore } from '@renderer/stores/threads'

// When this window saw each step of a session's plan start and finish, for the times its steps
// show. The plan carries no times, so a step already running or done when the session loaded has
// none, and shows none rather than a guess.

interface Seen {
  status: PlanItem['status']
  start?: number
  end?: number
}

const bySession = new Map<string, { plan: unknown; steps: Map<string, Seen> }>()

const keyOf = (item: PlanItem, index: number) => `${index}:${item.content}`

// The store changes on every streamed chunk, so the thread is read no further back than this.
const LOOKBACK = 256

function latestPlan(state: ThreadState): PlanItem[] | null {
  for (let i = state.order.length - 1; i >= Math.max(0, state.order.length - LOOKBACK); i--) {
    const entry = state.byId[state.order[i]!]
    if (entry?.kind === 'plan') return entry.items
  }
  return null
}

function observe(sessionId: string, items: PlanItem[]): void {
  const known = bySession.get(sessionId)
  if (known?.plan === items) return
  const steps = known?.steps ?? new Map<string, Seen>()
  const now = Date.now()
  items.forEach((item, i) => {
    const key = keyOf(item, i)
    const seen = steps.get(key)
    if (!known || !seen) {
      // A step seen first while it runs started some time before; only one that starts later counts.
      steps.set(
        key,
        known && item.status === 'in_progress'
          ? { status: item.status, start: now }
          : { status: item.status },
      )
      return
    }
    if (seen.status === item.status) return
    if (item.status === 'in_progress' && seen.start === undefined) seen.start = now
    if (item.status === 'completed' && seen.start !== undefined) seen.end = now
    seen.status = item.status
  })
  bySession.set(sessionId, { plan: items, steps })
}

useThreadsStore.subscribe((s) => {
  for (const [sessionId, replica] of Object.entries(s.replicas)) {
    const items = replica.state ? (latestPlan(replica.state) ?? replica.plan?.items) : null
    if (items) observe(sessionId, items)
  }
})

/** When a step started and how long it took, as far as this window saw it. */
export function stepTime(
  sessionId: string,
  item: PlanItem,
  index: number,
): { startedAt?: number; durationMs?: number } {
  const seen = bySession.get(sessionId)?.steps.get(keyOf(item, index))
  if (seen?.start === undefined) return {}
  return seen.end === undefined
    ? { startedAt: seen.start }
    : { startedAt: seen.start, durationMs: seen.end - seen.start }
}
