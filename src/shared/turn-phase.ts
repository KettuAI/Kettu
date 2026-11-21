// What a session's running turn is doing now, read from its latest entries: the thread's
// nine dots act it out, and the agent host carries it in the session's summary.

import type { ThreadState, ToolEntry, ToolKind } from './thread'

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
    | 'question'
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
const QUIET = new Set([
  'plan',
  'notice',
  'git',
  'artifact',
  'subagent',
  'memory',
  'control_ask',
  'control_note',
  'task_delivery',
])

// The phase is read on every streamed chunk, so a long run of tool calls is read no further back.
const LOOKBACK = 64

/**
 * The phase, from the turn's latest entries: a thought or a message of the agent that streams, or
 * the latest of the tool calls at the end that still runs. Finished tool calls at the end are
 * work between steps.
 */
export function turnPhase(state: ThreadState | null | undefined): TurnPhase {
  if (!state) return WORKING
  if (state.session.status === 'awaiting_permission') {
    return { phase: awaitsAnswer(state) ? 'question' : 'approval', count: 1 }
  }
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
 * Whether what the session waits on is a question to answer, not a permission, a plan or an MCP
 * server's request to decide: every pending request is one, as the thread's cards tell them apart.
 */
export function awaitsAnswer(state: ThreadState | null | undefined): boolean {
  if (!state) return false
  const { order, byId } = state
  let asked = false
  for (let i = order.length - 1; i >= Math.max(0, order.length - LOOKBACK); i--) {
    const entry = byId[order[i]!]
    if (entry?.kind !== 'tool' || !entry.permission) continue
    const { plan, elicitation, questions } = entry.permission
    if (plan || elicitation || (!questions && entry.question === undefined)) return false
    asked = true
  }
  return asked
}
