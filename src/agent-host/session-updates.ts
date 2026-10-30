// What a protocol's mapper produces against Kettu's session model: patches, and effects the host
// acts on. Every protocol's mapper produces these, and the helpers here hold for each of them.

import type { PlanLimit } from '@shared/agent-host'
import type {
  ConfigOption,
  Patch,
  StopReason,
  ThreadState,
  TokenTotals,
  ToolKind,
} from '@shared/thread'
import { ULTRACODE_OPTION_ID } from '@shared/thread'

/** Per-turn bookkeeping the mapper needs to find "current" entries. */
export interface TurnScope {
  planId: string | null
  /** Thought entries still streaming, with the time their first chunk arrived. */
  thoughts: Map<string, number>
}

export function newTurnScope(): TurnScope {
  return { planId: null, thoughts: new Map() }
}

export interface MapperContext {
  readonly thread: ThreadState
  /** True while `session/load` replays history into the thread. */
  readonly replaying: boolean
  /**
   * True while it replays a session whose adapter sends each part of a thought as a chunk of its
   * own, with nothing between them.
   */
  readonly thoughtParts: boolean
  /** The user stopped the turn and the agent has not answered its prompt yet. */
  readonly cancelling: boolean
  readonly scope: TurnScope
  readonly now: number
  /** The next `e:<n>` id of this session. */
  nextId(): string
  /** The Kettu id of a session of the same agent, by the agent's own id for it. */
  sessionIdFor(sessionId: string): string | null
}

export type SubagentState =
  | { kind: 'running' }
  | { kind: 'requires_action' }
  | {
      kind: 'idle'
      stopReason: string | null
      error: { message: string; detail?: string } | null
      tokens: TokenTotals | null
    }
  | { kind: 'unknown' }
  | { kind: 'cleared' }

export type MapperEffect =
  | {
      kind: 'subagent'
      /** The agent's own id for the subagent's session. */
      sessionId: string
      // Omitted fields are unchanged; null clears, as the subagents RFD specifies.
      title?: string | null
      description?: string | null
      canCancel?: boolean
      state?: SubagentState
    }
  | { kind: 'limit'; limit: PlanLimit }
  | { kind: 'title'; title: string | null }
  | { kind: 'ignored'; variant: string; detail: string }
  | {
      kind: 'tool'
      phase: 'started' | 'ended'
      toolCallId: string
      entryId: string
      toolKind: ToolKind
      output: string
    }
  // Work the agent runs on after its tool call ended, such as a command in the background.
  | { kind: 'background' }
  // The session's own thread sent a request to its model, which renews its prompt cache.
  | { kind: 'request' }
  // An image replayed by `session/load`, whose bytes the session keeps in its thread store.
  | {
      kind: 'replayImage'
      entryId: string
      attachmentId: string
      mimeType: string
      data: string // base64
    }

export interface MapperOutput {
  patches: Patch[]
  effects: MapperEffect[]
}

/** The id of the mode select Kettu makes from an agent's legacy `modes`. */
export const SYNTHETIC_MODE_ID = '__mode'

/**
 * New options replace the old ones, keeping the synthetic mode when nothing replaces it and the
 * host's own ultracode switch, which the agent never sends.
 */
export function mergeConfig(
  previous: readonly ConfigOption[],
  next: ConfigOption[],
): ConfigOption[] {
  const synthetic = previous.find((option) => option.id === SYNTHETIC_MODE_ID)
  const ultracode = previous.find((option) => option.id === ULTRACODE_OPTION_ID)
  const merged =
    synthetic && !next.some((option) => option.category === 'mode') ? [synthetic, ...next] : next
  return ultracode && !merged.some((option) => option.id === ULTRACODE_OPTION_ID)
    ? [...merged, ultracode]
    : merged
}

/** The text of the thread's first user message, or null when it is not in memory. */
export function firstUserMessage(thread: ThreadState): string | null {
  for (const id of thread.order) {
    const entry = thread.byId[id]
    if (entry?.kind !== 'user') continue
    const text = entry.content
      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join('\n')
    return text === '' ? null : text
  }
  return null
}

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim()

/**
 * Whether a title is only the first user message again: the whole of it, whatever its spacing, or
 * the message cut and ending in an ellipsis. Adapters send the first message as the title just
 * before their own comes.
 */
export function repeatsFirstMessage(title: string, message: string | null): boolean {
  if (message === null) return false
  const said = collapse(message)
  if (said === '') return false
  const cut = collapse(title)
  if (said === cut) return true
  return cut.endsWith('…') && cut.length > 1 && said.startsWith(cut.slice(0, -1))
}

/**
 * A session's totals with one more turn in them. The adapters report each turn's own counts, though
 * ACP's schema calls them totals. A count no turn has reported yet stays null.
 */
export function addTokenTotals(sum: TokenTotals | null, turn: TokenTotals): TokenTotals {
  if (!sum) return turn
  const add = (a: number | null, b: number | null): number | null =>
    a === null ? b : b === null ? a : a + b
  return {
    total: sum.total + turn.total,
    input: sum.input + turn.input,
    output: sum.output + turn.output,
    thought: add(sum.thought, turn.thought),
    cacheRead: add(sum.cacheRead, turn.cacheRead),
    cacheWrite: add(sum.cacheWrite, turn.cacheWrite),
  }
}

const STOP_REASONS: ReadonlySet<string> = new Set([
  'end_turn',
  'max_tokens',
  'max_turn_requests',
  'refusal',
  'cancelled',
])

export function isStopReason(value: unknown): value is StopReason {
  return typeof value === 'string' && STOP_REASONS.has(value)
}
