// The side chat as the thread stores it: what was asked beside a session and the agent picked to
// answer for it. Read back with every damaged entry dropped on its own.

import type { AgentId, SideChatCarried, SideChatEntry, SideChatStep } from '@shared/thread'

/** The side questions a session keeps; older ones go. */
export const SIDE_ENTRIES = 50

/** The side chat as the thread stores it; the route follows the agent, so it is not kept. */
export interface StoredSideChat {
  answerAgent: AgentId | null
  entries: SideChatEntry[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const STATUSES: ReadonlySet<unknown> = new Set(['answering', 'answered', 'failed', 'stopped'])
const ROUTES: ReadonlySet<unknown> = new Set(['claude', 'codex', 'hidden'])
const STEP_KINDS: ReadonlySet<unknown> = new Set(['read', 'search', 'run', 'other'])

function stepOf(value: unknown): SideChatStep | null {
  if (!isRecord(value) || !STEP_KINDS.has(value.kind) || typeof value.title !== 'string') {
    return null
  }
  return { kind: value.kind as SideChatStep['kind'], title: value.title }
}

function carriedOfStored(value: unknown): SideChatCarried | null {
  if (!isRecord(value)) return null
  const { first, recent, omitted, bytes } = value
  if (typeof first !== 'boolean') return null
  if (![recent, omitted, bytes].every((n) => typeof n === 'number' && Number.isFinite(n))) {
    return null
  }
  return { first, recent: recent as number, omitted: omitted as number, bytes: bytes as number }
}

function entryOf(value: unknown): SideChatEntry | null {
  if (!isRecord(value)) return null
  const { id, question, quote, agentId, route, status, answer, steps, carried, error } = value
  if (
    typeof id !== 'string' ||
    typeof question !== 'string' ||
    !(quote === null || typeof quote === 'string') ||
    typeof agentId !== 'string' ||
    !ROUTES.has(route) ||
    !STATUSES.has(status) ||
    typeof answer !== 'string' ||
    !(error === null || typeof error === 'string') ||
    typeof value.askedAt !== 'number' ||
    !(value.answeredAt === null || typeof value.answeredAt === 'number')
  ) {
    return null
  }
  return {
    id,
    question,
    quote,
    agentId: agentId as AgentId,
    route: route as SideChatEntry['route'],
    // An answer cut off by a restart never comes; it is kept as stopped.
    status: status === 'answering' ? 'stopped' : (status as SideChatEntry['status']),
    answer,
    steps: Array.isArray(steps) ? steps.flatMap((step) => stepOf(step) ?? []) : [],
    carried: carriedOfStored(carried),
    error,
    askedAt: value.askedAt,
    answeredAt: value.answeredAt,
  }
}

/** The stored side chat, its damaged entries dropped; null for none or one that does not parse. */
export function parseSideChat(value: unknown): StoredSideChat | null {
  if (!isRecord(value) || !Array.isArray(value.entries)) return null
  const answerAgent = typeof value.answerAgent === 'string' ? (value.answerAgent as AgentId) : null
  const entries = value.entries.flatMap((entry) => entryOf(entry) ?? [])
  return { answerAgent, entries: entries.slice(-SIDE_ENTRIES) }
}
