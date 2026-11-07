import type { SessionView, ThreadState, ToolEntry, ToolKind } from '@shared/thread'

/**
 * What the agent is doing now in its running turn. For a tool call's work, `count` is how many
 * such calls run at once; it is 1 otherwise.
 */
export interface TurnPhase {
  phase:
    | 'thinking'
    | 'execute'
    | 'read'
    | 'search'
    | 'fetch'
    | 'edit'
    | 'writing'
    | 'compacting'
    | 'approval'
    | 'working'
  count: number
}

const TOOL_PHASES: Partial<Record<ToolKind, TurnPhase['phase']>> = {
  execute: 'execute',
  read: 'read',
  search: 'search',
  fetch: 'fetch',
  edit: 'edit',
  delete: 'edit',
  move: 'edit',
}

const WORKING: TurnPhase = { phase: 'working', count: 1 }

// Entries that carry no output of their own, so the phase comes from what is before them.
const QUIET = new Set(['plan', 'notice', 'git', 'artifact', 'subagent'])

// The phase is read on every streamed chunk, so a long run of tool calls is read no further back.
const LOOKBACK = 64

/**
 * The phase, from the turn's latest entries: a thought or a message of the agent that streams, or
 * the latest of the tool calls at the end that still runs. Finished tool calls at the end are
 * work between steps.
 */
export function turnPhase(state: ThreadState | null | undefined): TurnPhase {
  if (!state) return WORKING
  if (state.session.status === 'awaiting_permission') return { phase: 'approval', count: 1 }
  const { order, byId } = state
  const running: ToolEntry[] = []
  let tools = false
  for (let i = order.length - 1; i >= Math.max(0, order.length - LOOKBACK); i--) {
    const entry = byId[order[i]!]
    if (!entry) continue
    if (entry.kind === 'tool') {
      tools = true
      if (entry.status === 'pending' || entry.status === 'in_progress') running.push(entry)
      continue
    }
    // A subagent's card after the message: the agent waits on it rather than writes.
    if (entry.kind === 'subagent' && !tools) return WORKING
    if (QUIET.has(entry.kind)) continue
    if (tools) break
    if (entry.kind === 'thought') return entry.streaming ? { phase: 'thinking', count: 1 } : WORKING
    if (entry.kind === 'agent') return entry.streaming ? { phase: 'writing', count: 1 } : WORKING
    if (entry.kind === 'compaction' && entry.status === 'in_progress') {
      return { phase: 'compacting', count: 1 }
    }
    // The turn's own message, or anything that ends a step.
    return WORKING
  }
  const phase = running[0] && TOOL_PHASES[running[0].toolKind]
  if (!phase) return WORKING
  return { phase, count: running.filter((tool) => TOOL_PHASES[tool.toolKind] === phase).length }
}

/**
 * The tokens the running turn has added to the context, from the context the agent reports during
 * the turn; null when it reports none, or after a compaction left the context smaller.
 */
export function turnTokens(session: SessionView | null | undefined): number | null {
  const start = session?.turnStartUsed ?? null
  const used = session?.usage?.used
  if (start === null || used === undefined) return null
  return used > start ? used - start : null
}

/**
 * Whether an entry is in the thread's latest turn: no message you sent as a turn of its own
 * follows it. A message steered into the turn does not start one.
 */
export function inLatestTurn(state: ThreadState, entryId: string): boolean {
  for (let i = state.order.length - 1; i >= 0; i--) {
    const id = state.order[i]!
    if (id === entryId) return true
    const entry = state.byId[id]
    if (entry?.kind === 'user' && !entry.steered) return false
  }
  return false
}

/**
 * Whether the thread's latest tool call is one you rejected, with no message from you since: what
 * you write next most likely says what to do instead.
 */
export function endedOnRejection(state: ThreadState | null | undefined): boolean {
  if (!state) return false
  const { order, byId } = state
  for (let i = order.length - 1; i >= Math.max(0, order.length - LOOKBACK); i--) {
    const entry = byId[order[i]!]
    if (entry?.kind === 'user') return false
    if (entry?.kind === 'tool') {
      const result = entry.permissionResult
      return typeof result === 'object' && result !== null && result.kind.startsWith('reject')
    }
  }
  return false
}

/**
 * The message the agent is still writing, when it is the turn's latest entry; once anything else
 * follows it, it reads as written even before the agent says so.
 */
export function writingId(state: ThreadState | null | undefined): string | null {
  if (!state) return null
  for (let i = state.order.length - 1; i >= 0; i--) {
    const entry = state.byId[state.order[i]!]
    // A plan or a notice may land while the message still streams; a subagent's card follows it.
    if (!entry || entry.kind === 'plan' || entry.kind === 'notice') continue
    return entry.kind === 'agent' && entry.streaming ? entry.id : null
  }
  return null
}
