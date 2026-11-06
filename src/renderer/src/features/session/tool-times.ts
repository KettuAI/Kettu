import type { ThreadState, ToolEntry } from '@shared/thread'
import { useThreadsStore } from '@renderer/stores/threads'

// When this window saw each tool call start and finish, for the time its card shows. The thread
// carries no times for tool calls, so a call already running or done when its session first
// loaded has none, and its card shows no time rather than a guess.

interface Seen {
  status: ToolEntry['status']
  start?: number
  end?: number
}

const bySession = new Map<string, { state: ThreadState; tools: Map<string, Seen> }>()

// Statuses change near the thread's end, so a patch is read no further back.
const LOOKBACK = 64

const isRunning = (status: ToolEntry['status']) => status === 'pending' || status === 'in_progress'

function observe(sessionId: string, state: ThreadState): void {
  const known = bySession.get(sessionId)
  if (known?.state === state) return
  const tools = known?.tools ?? new Map<string, Seen>()
  const { order, byId } = state
  const from = known ? Math.max(0, order.length - LOOKBACK) : 0
  const now = Date.now()
  for (let i = from; i < order.length; i++) {
    const entry = byId[order[i]!]
    if (entry?.kind !== 'tool') continue
    const seen = tools.get(entry.id)
    if (!known) {
      tools.set(entry.id, { status: entry.status })
      continue
    }
    if (!seen) {
      tools.set(
        entry.id,
        isRunning(entry.status) ? { status: entry.status, start: now } : { status: entry.status },
      )
      continue
    }
    if (seen.status === entry.status) continue
    if (isRunning(entry.status) && seen.start === undefined) seen.start = now
    if (!isRunning(entry.status) && isRunning(seen.status) && seen.start !== undefined) {
      seen.end = now
    }
    seen.status = entry.status
  }
  bySession.set(sessionId, { state, tools })
}

useThreadsStore.subscribe((s) => {
  for (const [sessionId, replica] of Object.entries(s.replicas)) {
    if (replica.state) observe(sessionId, replica.state)
  }
  // A session no longer watched starts over when it comes back, as if loaded for the first time.
  for (const sessionId of bySession.keys()) {
    if (!s.replicas[sessionId]?.state) bySession.delete(sessionId)
  }
})

/** When a tool call started and how long it took, as far as this window saw it. */
export function toolTime(
  sessionId: string,
  entryId: string,
): { startedAt?: number; durationMs?: number } {
  const seen = bySession.get(sessionId)?.tools.get(entryId)
  if (seen?.start === undefined) return {}
  return seen.end === undefined
    ? { startedAt: seen.start }
    : { startedAt: seen.start, durationMs: seen.end - seen.start }
}
