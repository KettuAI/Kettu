// The side chat as the thread stores it: what was asked beside a session and the agent picked to
// answer for it. Read back with every damaged entry dropped on its own.

import type { AgentId, SideChatEntry, SideChatSaw, SideChatStep } from '@shared/thread'

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
const ROUTES: ReadonlySet<unknown> = new Set(['claude', 'codex', 'fork', 'hidden'])
const STEP_KINDS: ReadonlySet<unknown> = new Set(['read', 'search', 'run', 'other'])

function stepOf(value: unknown): SideChatStep | null {
  if (!isRecord(value) || !STEP_KINDS.has(value.kind) || typeof value.title !== 'string') {
    return null
  }
  return { kind: value.kind as SideChatStep['kind'], title: value.title }
}

const SAW_SOURCES: ReadonlySet<unknown> = new Set(['agent', 'fork', 'copy'])
const FELL_BACK: ReadonlySet<unknown> = new Set(['claude', 'codex', 'fork'])

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0

function sawOfStored(value: unknown): SideChatSaw | null {
  if (!isRecord(value) || !SAW_SOURCES.has(value.source)) return null
  let copy: SideChatSaw['copy'] = null
  if (value.copy !== null && value.copy !== undefined) {
    const stored = value.copy
    if (
      !isRecord(stored) ||
      typeof stored.first !== 'boolean' ||
      !isCount(stored.turns) ||
      !isCount(stored.total) ||
      !isCount(stored.bytes)
    ) {
      return null
    }
    copy = { turns: stored.turns, total: stored.total, first: stored.first, bytes: stored.bytes }
  }
  if (value.source === 'copy' && copy === null) return null
  return {
    source: value.source as SideChatSaw['source'],
    compacted: isCount(value.compacted) ? value.compacted : 0,
    copy,
    fellBackFrom: FELL_BACK.has(value.fellBackFrom)
      ? (value.fellBackFrom as NonNullable<SideChatSaw['fellBackFrom']>)
      : null,
  }
}

// Entries stored before `saw` kept what a hidden session was given as `carried`.
function sawOfLegacy(value: unknown): SideChatSaw | null {
  if (!isRecord(value)) return null
  const { first, recent, omitted, bytes } = value
  if (typeof first !== 'boolean' || !isCount(recent) || !isCount(omitted) || !isCount(bytes)) {
    return null
  }
  return {
    source: 'copy',
    compacted: 0,
    copy: { turns: recent, total: recent + omitted, first, bytes },
    fellBackFrom: null,
  }
}

function entryOf(value: unknown): SideChatEntry | null {
  if (!isRecord(value)) return null
  const { id, question, quote, agentId, route, status, answer, steps, error } = value
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
    saw: sawOfStored(value.saw) ?? sawOfLegacy(value.carried),
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
