// Detects when agy (1.5.15+) has finished its current reply and is idle waiting on background
// work (sub-agents, background shell commands, or scheduled timers) while holding `session/prompt`
// open via WaitForConversationFullyIdle.
//
// In an agentic loop, a model step only yields control when a `PLANNER_RESPONSE` completes with no
// tool calls. Over ACP, agy emits `usage_update` when a model step finishes—and in agy 1.5.18+,
// `usage_update` arrives shortly BEFORE the step's `tool_call` (with no second `usage_update`
// after the tool runs), and `transcript.jsonl` may flush slightly after `usage_update`.
//
// When a step finishes without emitting any `tool_call` (including hidden internal tools), no
// permission or question card is pending, and `session/prompt` stays open past a short settle
// delay, the main session is idle waiting on background tasks rather than actively writing.
//
// As a fallback when agy omits `usage_update`, the tracker also checks the latest line of
// `transcript.jsonl` after streaming chunks go quiet.

import os from 'node:os'
import type * as acp from '@agentclientprotocol/sdk/unstable'
import { scanBackwards } from '../prompt-cache'
import { agyTranscriptFile } from './agy-metrics'

/** Max bytes read from the end of `transcript.jsonl` to inspect its latest step. */
const TAIL_BYTES = 256 * 1024

/** Grace delay after a tool-less `usage_update` so normal turn completions never flicker. */
export const DEFAULT_SETTLE_MS = 300

/** Idle delay after streamed chunks before checking `transcript.jsonl` as a fallback. */
export const DEFAULT_FALLBACK_MS = 1_500

/** Bounded backoff delays (ms) when `transcript.jsonl` has not flushed the new reply yet. */
export const DEFAULT_FLUSH_RETRIES_MS: readonly number[] = [200, 400, 800, 1_500]

/** Minimal metadata of the latest record written to agy's `transcript.jsonl`. */
export interface AgyTranscriptTail {
  stepIndex: number
  type: string
  status: string
  hasToolCalls: boolean
}

/** Reads the latest record of an agy session's `transcript.jsonl`, injectable for tests. */
export type AgyTailReader = (sessionId: string) => Promise<AgyTranscriptTail | null>

export interface AgyBackgroundWaitOptions {
  /** Optional reader for agy's `transcript.jsonl` tail; `null` disables disk checks. */
  tailReader?: AgyTailReader | null
  /** Grace delay (ms) after a tool-less `usage_update` before marking the session waiting. */
  settleMs?: number
  /** Quiet delay (ms) after streamed chunks before checking `transcript.jsonl` as a fallback. */
  fallbackMs?: number
  /** Bounded backoff delays (ms) to re-check `transcript.jsonl` when a fresh non-planner step is still on disk. */
  retryDelaysMs?: readonly number[]
  /** Called whenever a session enters or leaves the waiting-on-background-work state. */
  onWaitingChange: (sessionId: string, waiting: boolean) => void
}

interface SessionState {
  /** Whether the current model step emitted any thought or reply text chunk. */
  sawOutput: boolean
  /** Whether the current model step emitted any tool call (including hidden calls). */
  sawTool: boolean
  /** Tool call ids emitted during the current model step. */
  stepToolIds: Set<string>
  /** Tool call ids from earlier steps of this turn (e.g. background commands still in_progress). */
  priorToolIds: Set<string>
  /** Number of open permission or question cards blocking this session. */
  pendingCards: number
  /** Last context token count from `usage_update`, to ignore config-only updates. */
  lastUsed: number | null
  /** Whether this session is currently reported as waiting on background work. */
  waiting: boolean
  /** Debounce or flush-retry timer scheduled after a tool-less `usage_update`. */
  timer: ReturnType<typeof setTimeout> | null
  /** Fallback or flush-retry timer scheduled after streamed chunks go quiet. */
  fallbackTimer: ReturnType<typeof setTimeout> | null
  /** Incremented whenever activity invalidates pending timers or in-flight reads. */
  generation: number
  /** Latest transcript step_index observed before this step so old entries are never reused. */
  baselineStep: number | null
  /** In-flight baseline read started on prompt start or steer. */
  baseline: Promise<void> | null
}

function nonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/** Parses one JSONL line from agy's `transcript.jsonl` into tail metadata. */
export function parseAgyTranscriptTail(json: string): AgyTranscriptTail | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  const stepIndex = nonNegative(record.step_index)
  if (stepIndex === null || typeof record.type !== 'string') return null
  const toolCalls = record.tool_calls
  return {
    stepIndex,
    type: record.type,
    status: typeof record.status === 'string' ? record.status : '',
    hasToolCalls: Array.isArray(toolCalls) && toolCalls.length > 0,
  }
}

/** Reads the last valid JSONL record from `file`; returns null when missing or empty. */
export async function readLatestAgyTranscriptTail(file: string): Promise<AgyTranscriptTail | null> {
  let found: AgyTranscriptTail | null = null
  try {
    await scanBackwards(
      file,
      (line) => {
        if (line.length === 0) return false
        found = parseAgyTranscriptTail(line.toString('utf8'))
        return found !== null
      },
      { limit: TAIL_BYTES },
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  return found
}

/** Default tail reader pointing at `<home>/.gemini/<appDataDir>/brain/<sessionId>/...`. */
export function agyTailReader(
  home = os.homedir(),
  appDataDirOf?: (sessionId: string) => string | undefined,
): AgyTailReader {
  return async (sessionId) => {
    const file = agyTranscriptFile(sessionId, home, appDataDirOf?.(sessionId))
    if (!file) return null
    return readLatestAgyTranscriptTail(file).catch(() => null)
  }
}

function isFinishedNoToolReply(tail: AgyTranscriptTail): boolean {
  return tail.type === 'PLANNER_RESPONSE' && tail.status === 'DONE' && !tail.hasToolCalls
}

/**
 * Tracks running agy prompts and reports when the main session has finished replying and is only
 * held open waiting for background tasks, sub-agents, or scheduled timers.
 */
export class AgyBackgroundWait {
  private readonly states = new Map<string, SessionState>()
  private readonly tailReader: AgyTailReader | null
  private readonly settleMs: number
  private readonly fallbackMs: number
  private readonly retryDelaysMs: readonly number[]
  private readonly onWaitingChange: (sessionId: string, waiting: boolean) => void
  private stopped = false

  constructor(options: AgyBackgroundWaitOptions) {
    this.tailReader = options.tailReader ?? null
    this.settleMs = options.settleMs ?? DEFAULT_SETTLE_MS
    this.fallbackMs = options.fallbackMs ?? DEFAULT_FALLBACK_MS
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_FLUSH_RETRIES_MS
    this.onWaitingChange = options.onWaitingChange
  }

  /** Starts tracking a newly sent `session/prompt` turn. */
  onPromptStart(sessionId: string, currentUsed: number | null): void {
    if (this.stopped) return
    const previous = this.states.get(sessionId)
    if (previous) this.clearTimers(previous)
    const state: SessionState = {
      sawOutput: false,
      sawTool: false,
      stepToolIds: new Set(),
      priorToolIds: new Set(),
      pendingCards: previous?.pendingCards ?? 0,
      lastUsed: currentUsed,
      waiting: false,
      timer: null,
      fallbackTimer: null,
      generation: (previous?.generation ?? 0) + 1,
      baselineStep: previous?.baselineStep ?? null,
      baseline: null,
    }
    this.states.set(sessionId, state)
    this.refreshBaseline(sessionId, state)
  }

  /** Current generation of `sessionId`, to avoid clearing updates that arrived mid-steer. */
  generationOf(sessionId: string): number {
    return this.states.get(sessionId)?.generation ?? 0
  }

  /** Resets active-step state once a follow-up prompt is steered into the open turn. */
  onSteered(sessionId: string, beforeGeneration?: number): void {
    const state = this.states.get(sessionId)
    if (!state) return
    const unchanged = beforeGeneration === undefined || state.generation === beforeGeneration
    if (unchanged) {
      this.clearTimers(state)
      state.generation++
      state.sawOutput = false
      this.retireStepTools(state)
    }
    if (state.waiting) {
      state.waiting = false
      this.onWaitingChange(sessionId, false)
    }
    if (unchanged) this.refreshBaseline(sessionId, state)
  }

  /** Marks that a permission request or question card is blocking this session. */
  onCardStart(sessionId: string): void {
    const state = this.states.get(sessionId)
    if (!state) return
    state.pendingCards++
    this.clearTimers(state)
    state.generation++
    if (state.waiting) {
      state.waiting = false
      this.onWaitingChange(sessionId, false)
    }
  }

  /** Marks that a permission request or question card settled for this session. */
  onCardEnd(sessionId: string): void {
    const state = this.states.get(sessionId)
    if (!state) return
    state.pendingCards = Math.max(0, state.pendingCards - 1)
  }

  /** Processes a raw ACP `session/update` (before hidden Kettu/brain tools are filtered out). */
  onUpdate(sessionId: string, update: acp.SessionUpdate, replaying: boolean): void {
    if (this.stopped || replaying) return
    const state = this.states.get(sessionId)
    if (!state) return

    switch (update.sessionUpdate) {
      case 'agent_thought_chunk':
      case 'agent_message_chunk': {
        this.clearTimers(state)
        state.generation++
        if (state.waiting) {
          state.waiting = false
          this.onWaitingChange(sessionId, false)
        }
        // In agy 1.5.18+, `tool_call` arrives after the tool step's `usage_update` and no second
        // `usage_update` follows once the tool runs. Any new thought or reply chunk begins a new
        // model step, so stale tool state from the previous step must not leak into it.
        if (state.sawTool) this.retireStepTools(state)
        state.sawOutput = true
        if (this.tailReader && state.pendingCards === 0) {
          this.scheduleFallback(sessionId, state)
        }
        return
      }
      case 'tool_call': {
        this.clearTimers(state)
        state.generation++
        if (state.waiting) {
          state.waiting = false
          this.onWaitingChange(sessionId, false)
        }
        state.stepToolIds.add(update.toolCallId)
        state.priorToolIds.delete(update.toolCallId)
        state.sawTool = true
        return
      }
      case 'tool_call_update': {
        // Ignore progress or completion updates from tools started in earlier steps (e.g. a
        // background command still running while a later step replies or waits).
        if (state.priorToolIds.has(update.toolCallId)) return
        if (!state.waiting && (update.status === 'pending' || update.status === 'in_progress')) {
          this.clearTimers(state)
          state.generation++
          state.stepToolIds.add(update.toolCallId)
          state.sawTool = true
        }
        return
      }
      case 'usage_update': {
        const usageChanged = state.lastUsed === null || update.used !== state.lastUsed
        state.lastUsed = update.used
        // Ignore initial pre-step `used: 0` updates and config-only updates with unchanged `used`.
        const hadStep = state.sawOutput || (usageChanged && update.used > 0)
        if (!hadStep) return
        if (state.fallbackTimer) {
          clearTimeout(state.fallbackTimer)
          state.fallbackTimer = null
        }
        const hadTool = state.sawTool
        state.sawOutput = false
        this.retireStepTools(state)
        if (hadTool || state.pendingCards > 0 || state.waiting) {
          if (state.timer) {
            clearTimeout(state.timer)
            state.timer = null
          }
          return
        }
        this.scheduleSettle(sessionId, state)
        return
      }
    }
  }

  /** Cleans up tracking when the session's `session/prompt` chain finishes. */
  onPromptEnd(sessionId: string): void {
    const state = this.states.get(sessionId)
    if (!state) return
    this.clearTimers(state)
    state.generation++
    this.states.delete(sessionId)
  }

  /** Whether this session is currently marked as waiting on background work. */
  isWaiting(sessionId: string): boolean {
    return this.states.get(sessionId)?.waiting === true
  }

  /** Drops all state for a closed or unregistered session. */
  forget(sessionId: string): void {
    const state = this.states.get(sessionId)
    if (!state) return
    this.clearTimers(state)
    state.generation++
    this.states.delete(sessionId)
  }

  /** Stops all timers across every tracked session. */
  stop(): void {
    this.stopped = true
    for (const state of this.states.values()) {
      this.clearTimers(state)
      state.generation++
    }
    this.states.clear()
  }

  private retireStepTools(state: SessionState): void {
    for (const id of state.stepToolIds) state.priorToolIds.add(id)
    state.stepToolIds.clear()
    state.sawTool = false
  }

  private clearTimers(state: SessionState): void {
    if (state.timer) {
      clearTimeout(state.timer)
      state.timer = null
    }
    if (state.fallbackTimer) {
      clearTimeout(state.fallbackTimer)
      state.fallbackTimer = null
    }
  }

  private refreshBaseline(sessionId: string, state: SessionState): void {
    if (!this.tailReader) return
    const generation = state.generation
    state.baseline = this.tailReader(sessionId)
      .then((tail) => {
        if (this.states.get(sessionId) !== state || state.generation !== generation) return
        if (tail) state.baselineStep = Math.max(state.baselineStep ?? -1, tail.stepIndex)
      })
      .catch(() => {})
  }

  private scheduleSettle(sessionId: string, state: SessionState): void {
    if (state.timer) clearTimeout(state.timer)
    const generation = ++state.generation
    state.timer = setTimeout(() => {
      state.timer = null
      void this.confirmWaiting(sessionId, state, generation, false, 0)
    }, this.settleMs)
    state.timer.unref?.()
  }

  private scheduleRetry(
    sessionId: string,
    state: SessionState,
    generation: number,
    requireTranscript: boolean,
    attempt: number,
  ): void {
    const delay = this.retryDelaysMs[attempt]
    if (delay === undefined) return
    if (requireTranscript) {
      if (state.fallbackTimer) clearTimeout(state.fallbackTimer)
      state.fallbackTimer = setTimeout(() => {
        state.fallbackTimer = null
        void this.confirmWaiting(sessionId, state, generation, true, attempt + 1)
      }, delay)
      state.fallbackTimer.unref?.()
      return
    }
    if (state.timer) clearTimeout(state.timer)
    state.timer = setTimeout(() => {
      state.timer = null
      void this.confirmWaiting(sessionId, state, generation, false, attempt + 1)
    }, delay)
    state.timer.unref?.()
  }

  private scheduleFallback(sessionId: string, state: SessionState): void {
    if (state.fallbackTimer) clearTimeout(state.fallbackTimer)
    const generation = state.generation
    state.fallbackTimer = setTimeout(() => {
      state.fallbackTimer = null
      void this.confirmWaiting(sessionId, state, generation, true, 0)
    }, this.fallbackMs)
    state.fallbackTimer.unref?.()
  }

  private async confirmWaiting(
    sessionId: string,
    state: SessionState,
    generation: number,
    requireTranscript: boolean,
    attempt: number,
  ): Promise<void> {
    if (this.stopped || this.states.get(sessionId) !== state || state.generation !== generation) {
      return
    }
    if (state.waiting || state.pendingCards > 0 || state.sawTool) return

    if (this.tailReader) {
      if (state.baseline) await state.baseline
      if (this.stopped || this.states.get(sessionId) !== state || state.generation !== generation) {
        return
      }
      const tail = await this.tailReader(sessionId).catch(() => null)
      if (this.stopped || this.states.get(sessionId) !== state || state.generation !== generation) {
        return
      }
      if (state.waiting || state.pendingCards > 0 || state.sawTool) return

      if (tail) {
        const isFresh = state.baselineStep === null || tail.stepIndex > state.baselineStep
        if (isFinishedNoToolReply(tail)) {
          if (requireTranscript && !isFresh) return
          state.baselineStep = Math.max(state.baselineStep ?? -1, tail.stepIndex)
        } else if (tail.type === 'PLANNER_RESPONSE') {
          // A fresh PLANNER_RESPONSE with tool calls or still running means the model step did not
          // yield control; abort immediately without retrying.
          if (requireTranscript || isFresh) return
        } else {
          // A fresh non-planner entry (e.g. GENERIC, SYSTEM_MESSAGE, USER_INPUT) can appear either
          // while the new PLANNER_RESPONSE is still flushing to disk or while the agent is between
          // steps. Re-check on a bounded backoff and never mark waiting unless a tool-less DONE
          // PLANNER_RESPONSE arrives.
          if (isFresh) {
            this.scheduleRetry(sessionId, state, generation, requireTranscript, attempt)
            return
          }
          if (requireTranscript) return
        }
      } else if (requireTranscript) {
        return
      }
    } else if (requireTranscript) {
      return
    }

    state.waiting = true
    this.onWaitingChange(sessionId, true)
  }
}
