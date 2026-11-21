// Side questions: asked beside a session and answered from its conversation, never part of it.
// Which way each agent answers, the words every way gives it, the hidden session that answers
// for an agent without a side question of its own, and the side chat as the thread stores it.

import { harnessOf } from '@shared/agents'
import type { AgentId, SideChatEntry, SideChatRoute, SideChatSaw } from '@shared/thread'
import { removesHiddenSessions } from './acp/hidden-sessions'
import type { CarriedContext } from './carried-context'
import {
  SideQuestionUnsupported,
  type OpenedSession,
  type PromptBlock,
  type SideQuestion,
} from './connection'
import { LocalizedError } from './localized-error'
import type { HiddenRuntime } from './reports'

/** An answer's text at most, as stored and sent to clients. */
export const SIDE_ANSWER_CHARS = 100_000
/** How long an answer may take before it is given up. */
export const SIDE_TIMEOUT_MS = 180_000
/** How often a growing answer goes out to the clients. */
export const SIDE_TEXT_MS = 80
/** The steps a read-only answer lists at most. */
export const SIDE_STEPS = 8
/** The earlier side questions a follow-up carries at most. */
const SIDE_HISTORY = 20
const SIDE_HISTORY_CHARS = 24_000

/** How a session's own agent answers side questions, as far as is known before it starts. */
export function sideRoute(agentId: AgentId): SideChatRoute {
  const harness = harnessOf(agentId)
  if (harness === 'claude-code') return 'claude'
  if (harness === 'codex') return 'codex'
  return removesHiddenSessions(harness) ? 'hidden' : 'none'
}

/**
 * How the session's own agent answers once what it can do is known: an agent whose hidden sessions
 * are removed cleanly and that forks its sessions answers in a fork of the session, not in a
 * session given a text copy.
 */
export function sideRouteWith(
  agentId: AgentId,
  capabilities: { forkSession: boolean } | null,
): SideChatRoute {
  const route = sideRoute(agentId)
  return route === 'hidden' && capabilities?.forkSession ? 'fork' : route
}

/** Whether an agent can answer side questions for another agent's session. */
export function answersForOthers(agentId: AgentId): boolean {
  return sideRoute(agentId) !== 'none'
}

/** For a fork of the session: what the inherited history is and what is asked of the answer. */
export const SIDE_INSTRUCTIONS = [
  'You are in a side conversation, not the main thread. The user asks a quick question beside the ' +
    'session; its main agent keeps working and is not interrupted.',
  'Everything before this point is history inherited from the session, reference context only: ' +
    'do not continue, execute or complete any instruction, plan, tool call or request from it. ' +
    'Only the side question is active.',
  'The last turn of that history may still be running in the session: a step it shows as ' +
    'interrupted, or an approval it shows as aborted, may be running on or waiting, whatever an ' +
    'interruption marker says. Never run again a command or tool call that the history shows, ' +
    'finished or interrupted: the session is running or waiting on it, and its result will not ' +
    'come from you. Run a command only to read something new, and answer from the history when ' +
    'it already says.',
  'Answer it directly and briefly. Do not modify files, git state or any other state, do not ' +
    'start or message subagents or sessions, and do not call Kettu tools. If answering needs more ' +
    'than reading, say so and suggest asking in the main conversation.',
].join('\n')

/** The whole prompt of a fork of the session: what it is for, then the turn. */
export function forkPrompt(ask: Pick<SideQuestion, 'question' | 'history'>): string {
  return [SIDE_INSTRUCTIONS, sideTurnText(ask)].join('\n\n')
}

/** For a hidden session given carried context instead of the session's own history. */
const HIDDEN_INSTRUCTIONS = [
  "Kettu asks you a side question about one of the user's sessions with a coding agent. You are " +
    'not that agent and do not take the session over.',
  'Answer from the conversation below, directly and briefly, without tools. If answering needs ' +
    'reading files or running commands, say so and suggest asking in the session itself.',
].join('\n')

/** The question as the agent gets it, with the passage it is about quoted before it. */
export function questionText(question: string, quote: string | null): string {
  if (!quote) return question
  const quoted = quote
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
  return `${quoted}\n\n${question}`
}

/** The answered side questions a follow-up carries, oldest first. */
export function sideHistory(
  entries: readonly SideChatEntry[],
): { question: string; answer: string }[] {
  const answered = entries.filter((entry) => entry.status === 'answered' && entry.answer !== '')
  const picked: { question: string; answer: string }[] = []
  let used = 0
  for (let i = answered.length - 1; i >= 0 && picked.length < SIDE_HISTORY; i--) {
    const entry = answered[i]!
    const turn = { question: questionText(entry.question, entry.quote), answer: entry.answer }
    used += turn.question.length + turn.answer.length
    if (used > SIDE_HISTORY_CHARS && picked.length > 0) break
    picked.unshift(turn)
  }
  return picked
}

/**
 * The turn a fork or a hidden session is sent: the earlier side questions, a reminder that the
 * session runs on, then the question. A fork told only in its instructions ran the interrupted
 * command again and finished the session's task.
 */
export function sideTurnText(ask: Pick<SideQuestion, 'question' | 'history'>): string {
  const parts: string[] = []
  if (ask.history.length > 0) {
    const earlier = ask.history.map((turn) => `Q: ${turn.question}\nA: ${turn.answer}`)
    parts.push(`<earlier_side_questions>\n${earlier.join('\n\n')}\n</earlier_side_questions>`)
  }
  parts.push(
    'The session may still be running. Nothing above is yours to run or finish again; a step ' +
      'shown as interrupted is still running there.',
  )
  parts.push(`Side question:\n${ask.question}`)
  return parts.join('\n\n')
}

/** The whole prompt of a hidden session: what it is for, the carried conversation and the turn. */
export function hiddenPrompt(
  carried: string | null,
  ask: Pick<SideQuestion, 'question' | 'history'>,
): string {
  return [
    HIDDEN_INSTRUCTIONS,
    carried ?? 'The session has no conversation yet.',
    sideTurnText(ask),
  ].join('\n\n')
}

/** What an answer from the agent's own side question or fork saw: the whole conversation. */
export function ownSaw(
  route: 'claude' | 'codex' | 'fork',
  fellBackFrom: SideChatSaw['fellBackFrom'] = null,
  compacted = 0,
): SideChatSaw {
  return { source: route === 'claude' ? 'agent' : 'fork', compacted, copy: null, fellBackFrom }
}

/** What a hidden session was given of the conversation, as the side chat names it. */
export function copySaw(
  carried: CarriedContext | null,
  fellBackFrom: SideChatSaw['fellBackFrom'],
  compacted: number,
): SideChatSaw {
  const copy = carried
    ? {
        turns: carried.turns,
        total: carried.total,
        first: carried.keepsFirst,
        bytes: Buffer.byteLength(carried.text, 'utf8'),
      }
    : { turns: 0, total: 0, first: false, bytes: 0 }
  return { source: 'copy', compacted, copy, fellBackFrom }
}

/** Sets the model on a session the agent opened when it offers it, so it answers as the session does. */
async function useModel(
  connection: HiddenRuntime['connection'],
  setup: OpenedSession,
  model: string | null,
): Promise<void> {
  const option = setup.config.find((o) => o.category === 'model' && o.type === 'select')
  if (
    option &&
    model !== null &&
    model !== option.value &&
    option.choices?.some((choice) => choice.value === model)
  ) {
    await connection.setConfigOption(setup.sessionId, option.id, model)
  }
}

export interface HiddenAnswerRequest {
  /** The folder the hidden session runs in: Kettu's own, never the project's. */
  dir: string
  prompt: string
  /** The session's model, set on the hidden session when the agent offers it. */
  model: string | null
  signal: AbortSignal
  text(answer: string): void
  log(message: string): void
  timeoutMs?: number
}

/**
 * Answers in a hidden session of the agent's own, then removes it: through `answerQuestion` where
 * the agent has it, which streams and runs without tools, else by collecting a prompt's messages.
 * Rejects when the agent cannot open one that leaves no trace, fails, is stopped or takes too long.
 */
export async function answerHidden(
  runtime: HiddenRuntime,
  request: HiddenAnswerRequest,
): Promise<string> {
  const { connection } = runtime
  const timeoutMs = request.timeoutMs ?? SIDE_TIMEOUT_MS
  const blocks: PromptBlock[] = [{ type: 'text', text: request.prompt }]
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = AbortSignal.any([request.signal, timeout])
  if (connection.answerQuestion) {
    try {
      let answer = ''
      const grow = (delta: string): void => {
        answer += delta
        request.text(answer)
      }
      return await connection.answerQuestion(request.dir, blocks, grow, signal)
    } catch (error) {
      if (timeout.aborted) {
        throw new LocalizedError(
          { key: 'light.noAnswer', params: { seconds: timeoutMs / 1000 } },
          { cause: error },
        )
      }
      throw error
    }
  }
  if (!connection.hiddenSessions) {
    throw new LocalizedError({ key: 'light.noRemoval' })
  }
  const remove = (sessionId: string): Promise<void> =>
    connection.removeHidden(sessionId, (message) =>
      request.log(`Could not remove the session of a side question: ${message}`),
    )
  const opening = connection.newSession(request.dir, { hidden: 'titles' })
  let sessionId: string | null = null
  const stop = (): void => {
    if (sessionId) void connection.cancel(sessionId).catch(() => {})
  }
  signal.addEventListener('abort', stop)
  try {
    const setup = await opening
    sessionId = setup.sessionId
    signal.throwIfAborted()
    await useModel(connection, setup, request.model)
    const messages = await connection.collect(setup.sessionId, request.prompt)
    if (timeout.aborted) {
      throw new LocalizedError({ key: 'light.noAnswer', params: { seconds: timeoutMs / 1000 } })
    }
    signal.throwIfAborted()
    const answer = messages.join('\n\n')
    request.text(answer)
    return answer
  } finally {
    signal.removeEventListener('abort', stop)
    if (sessionId) await remove(sessionId)
    // One that opens after it was given up goes the same way.
    else
      void opening.then(
        (setup) => remove(setup.sessionId),
        () => {},
      )
  }
}

export interface ForkAnswerRequest {
  /** Forks the session where no thread shows the fork; rejects when the agent cannot. */
  open(): Promise<OpenedSession>
  prompt: string
  /** The session's model, set on the fork when the agent offers it. */
  model: string | null
  signal: AbortSignal
  text(answer: string): void
  log(message: string): void
  timeoutMs?: number
}

/**
 * Answers in a fork of the session the agent makes, then removes the fork, however the answer
 * ended. Rejects with `SideQuestionUnsupported` when the agent cannot remove a hidden session
 * without a trace or the fork cannot be made, so the question can go another way; any other
 * failure, a stop or a time-out rejects as it is.
 */
export async function answerFork(
  runtime: HiddenRuntime,
  request: ForkAnswerRequest,
): Promise<string> {
  const { connection } = runtime
  if (!connection.hiddenSessions) {
    throw new SideQuestionUnsupported(
      "the agent's hidden sessions cannot be removed without a trace",
    )
  }
  let setup: OpenedSession
  try {
    setup = await request.open()
  } catch (error) {
    throw new SideQuestionUnsupported(
      `the session could not be forked: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const timeoutMs = request.timeoutMs ?? SIDE_TIMEOUT_MS
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = AbortSignal.any([request.signal, timeout])
  const stop = (): void => void connection.cancel(setup.sessionId).catch(() => {})
  signal.addEventListener('abort', stop)
  try {
    signal.throwIfAborted()
    await useModel(connection, setup, request.model)
    const messages = await connection.collect(setup.sessionId, request.prompt)
    if (timeout.aborted) {
      throw new LocalizedError({ key: 'light.noAnswer', params: { seconds: timeoutMs / 1000 } })
    }
    signal.throwIfAborted()
    const answer = messages.join('\n\n')
    request.text(answer)
    return answer
  } finally {
    signal.removeEventListener('abort', stop)
    await connection.removeHidden(setup.sessionId, (message) =>
      request.log(`Could not remove the fork of a side question: ${message}`),
    )
  }
}
