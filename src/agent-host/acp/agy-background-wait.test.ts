import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type * as acp from '@agentclientprotocol/sdk/unstable'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AgyBackgroundWait,
  parseAgyTranscriptTail,
  readLatestAgyTranscriptTail,
  type AgyTranscriptTail,
} from './agy-background-wait'

const tempDirs: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const msgChunk = (text: string): acp.SessionUpdate => ({
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'text', text },
})

const thoughtChunk = (text: string): acp.SessionUpdate => ({
  sessionUpdate: 'agent_thought_chunk',
  content: { type: 'text', text },
})

const toolCall = (
  toolCallId: string,
  name: string,
  status: acp.ToolCallStatus = 'in_progress',
): acp.SessionUpdate =>
  ({
    sessionUpdate: 'tool_call',
    toolCallId,
    name,
    title: `Run ${name}`,
    kind: 'other',
    status,
  }) as unknown as acp.SessionUpdate

const toolUpdate = (toolCallId: string, status: acp.ToolCallStatus): acp.SessionUpdate =>
  ({
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status,
  }) as unknown as acp.SessionUpdate

const usageUpdate = (used: number, size = 1_048_576): acp.SessionUpdate => ({
  sessionUpdate: 'usage_update',
  used,
  size,
})

describe('agy transcript tail parsing', () => {
  it('parses PLANNER_RESPONSE with and without tool_calls and skips invalid lines', () => {
    expect(parseAgyTranscriptTail('not json')).toBeNull()
    expect(parseAgyTranscriptTail('{"type":"GENERIC"}')).toBeNull()
    expect(
      parseAgyTranscriptTail(
        JSON.stringify({
          step_index: 10,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          content: 'Waiting for background tasks.',
        }),
      ),
    ).toEqual({
      stepIndex: 10,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      hasToolCalls: false,
    })
    expect(
      parseAgyTranscriptTail(
        JSON.stringify({
          step_index: 11,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          tool_calls: [{ name: 'run_command' }],
        }),
      ),
    ).toEqual({
      stepIndex: 11,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      hasToolCalls: true,
    })
  })

  it('reads the last valid JSONL record from disk and returns null when missing', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agy-wait-'))
    tempDirs.push(dir)
    expect(await readLatestAgyTranscriptTail(path.join(dir, 'missing.jsonl'))).toBeNull()

    const file = path.join(dir, 'transcript.jsonl')
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(
      file,
      [
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          tool_calls: [{ name: 'invoke_subagent' }],
        }),
        JSON.stringify({ step_index: 2, type: 'GENERIC', status: 'DONE' }),
        JSON.stringify({
          step_index: 3,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          content: 'Launched the sub-agent.',
        }),
      ].join('\n') + '\n',
    )
    expect(await readLatestAgyTranscriptTail(file)).toEqual({
      stepIndex: 3,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      hasToolCalls: false,
    })
  })

  it('skips trailing CHECKPOINT lines and surfaces latestPlanner behind SYSTEM_MESSAGE or GENERIC', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agy-wait-'))
    tempDirs.push(dir)
    const file = path.join(dir, 'transcript.jsonl')
    await writeFile(
      file,
      [
        JSON.stringify({ step_index: 1, type: 'USER_INPUT', status: 'DONE' }),
        JSON.stringify({
          step_index: 2,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          content: 'Monitoring build.',
        }),
        JSON.stringify({ step_index: 3, type: 'SYSTEM_MESSAGE', status: 'DONE' }),
        JSON.stringify({ step_index: 4, type: 'CHECKPOINT', status: 'DONE' }),
      ].join('\n') + '\n',
    )
    expect(await readLatestAgyTranscriptTail(file)).toEqual({
      stepIndex: 3,
      type: 'SYSTEM_MESSAGE',
      status: 'DONE',
      hasToolCalls: false,
      latestPlanner: { stepIndex: 2, status: 'DONE', hasToolCalls: false },
    })

    // Stops lookback at USER_INPUT so an earlier turn's PLANNER_RESPONSE is never leaked across turns.
    const nextFile = path.join(dir, 'next.jsonl')
    await writeFile(
      nextFile,
      [
        JSON.stringify({ step_index: 2, type: 'PLANNER_RESPONSE', status: 'DONE' }),
        JSON.stringify({ step_index: 3, type: 'USER_INPUT', status: 'DONE' }),
        JSON.stringify({ step_index: 4, type: 'SYSTEM_MESSAGE', status: 'DONE' }),
      ].join('\n') + '\n',
    )
    expect(await readLatestAgyTranscriptTail(nextFile)).toEqual({
      stepIndex: 4,
      type: 'SYSTEM_MESSAGE',
      status: 'DONE',
      hasToolCalls: false,
    })
  })
})

describe('AgyBackgroundWait', () => {
  it('marks waiting after a tool-less reply settles, and never flickers on normal turn end', async () => {
    vi.useFakeTimers()
    const events: [string, boolean][] = []
    const tracker = new AgyBackgroundWait({
      tailReader: null,
      settleMs: 300,
      onWaitingChange: (id, waiting) => events.push([id, waiting]),
    })

    // Normal turn: prompt ends within settleMs, so waiting never fires.
    tracker.onPromptStart('s-normal', 1_000)
    tracker.onUpdate('s-normal', msgChunk('All done.'), false)
    tracker.onUpdate('s-normal', usageUpdate(1_200), false)
    await vi.advanceTimersByTimeAsync(100)
    tracker.onPromptEnd('s-normal')
    await vi.advanceTimersByTimeAsync(500)
    expect(events).toEqual([])

    // Background wait: prompt stays open after a tool-less step.
    tracker.onPromptStart('s-bg', 1_200)
    tracker.onUpdate('s-bg', toolCall('c1', 'invoke_subagent', 'in_progress'), false)
    tracker.onUpdate('s-bg', toolUpdate('c1', 'completed'), false)
    tracker.onUpdate('s-bg', usageUpdate(1_500), false)
    await vi.advanceTimersByTimeAsync(500)
    // Step 1 had a tool call, so it must not enter waiting.
    expect(events).toEqual([])

    // Step 2 writes the reply with no tool calls and emits usage_update.
    tracker.onUpdate('s-bg', msgChunk('Sub-agent started.'), false)
    tracker.onUpdate('s-bg', usageUpdate(1_700), false)
    await vi.advanceTimersByTimeAsync(299)
    expect(events).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(events).toEqual([['s-bg', true]])
    expect(tracker.isWaiting('s-bg')).toBe(true)

    // Background wakeup arrives later on the same prompt -> leaves waiting immediately.
    tracker.onUpdate('s-bg', thoughtChunk('The sub-agent replied.'), false)
    expect(events).toEqual([
      ['s-bg', true],
      ['s-bg', false],
    ])
    expect(tracker.isWaiting('s-bg')).toBe(false)
    tracker.stop()
  })

  it('handles background commands that remain in_progress across steps and ignores config-only usage updates', async () => {
    vi.useFakeTimers()
    const events: boolean[] = []
    const tracker = new AgyBackgroundWait({
      tailReader: null,
      settleMs: 100,
      onWaitingChange: (_id, waiting) => events.push(waiting),
    })

    tracker.onPromptStart('s-1', 2_000)
    // Step 1 starts a long-running background shell command that stays in_progress.
    tracker.onUpdate('s-1', toolCall('cmd-1', 'run_command', 'in_progress'), false)
    tracker.onUpdate('s-1', usageUpdate(2_300), false)
    await vi.advanceTimersByTimeAsync(200)
    expect(events).toEqual([])

    // Config-only usage_update with unchanged `used` and no output does not trigger waiting.
    tracker.onUpdate('s-1', usageUpdate(2_300, 200_000), false)
    await vi.advanceTimersByTimeAsync(200)
    expect(events).toEqual([])

    // Step 2 replies to the user while cmd-1 is still in_progress.
    tracker.onUpdate('s-1', msgChunk('Running the build in the background.'), false)
    tracker.onUpdate('s-1', usageUpdate(2_500), false)
    await vi.advanceTimersByTimeAsync(100)
    expect(events).toEqual([true])

    // Background command completion update does not prematurely drop waiting until agent wakes up.
    tracker.onUpdate('s-1', toolUpdate('cmd-1', 'completed'), false)
    expect(events).toEqual([true])

    // Model wakes up with a new reply -> exits waiting cleanly.
    tracker.onUpdate('s-1', msgChunk('Build succeeded!'), false)
    expect(events).toEqual([true, false])
    tracker.stop()
  })

  it('does not trigger waiting while a hidden tool call or permission/question card is active', async () => {
    vi.useFakeTimers()
    const events: boolean[] = []
    const tracker = new AgyBackgroundWait({
      tailReader: null,
      settleMs: 100,
      onWaitingChange: (_id, waiting) => events.push(waiting),
    })

    tracker.onPromptStart('s-1', 1_000)
    // Hidden tool call (e.g. mcp_kettu_suggest_next_message) still counts as sawTool.
    tracker.onUpdate('s-1', msgChunk('Let me suggest a follow-up.'), false)
    tracker.onUpdate('s-1', toolCall('h1', 'mcp_kettu_suggest_next_message', 'in_progress'), false)
    tracker.onUpdate('s-1', usageUpdate(1_200), false)
    await vi.advanceTimersByTimeAsync(300)
    expect(events).toEqual([])

    // Permission/question card blocks waiting even if usage_update arrives without sawTool.
    tracker.onCardStart('s-1')
    tracker.onUpdate('s-1', msgChunk('Please confirm.'), false)
    tracker.onUpdate('s-1', usageUpdate(1_400), false)
    await vi.advanceTimersByTimeAsync(300)
    expect(events).toEqual([])
    tracker.onCardEnd('s-1')

    // Once waiting, opening a card clears waiting immediately.
    tracker.onUpdate('s-1', msgChunk('Waiting now.'), false)
    tracker.onUpdate('s-1', usageUpdate(1_600), false)
    await vi.advanceTimersByTimeAsync(100)
    expect(events).toEqual([true])
    tracker.onCardStart('s-1')
    expect(events).toEqual([true, false])
    tracker.onCardEnd('s-1')
    tracker.stop()
  })

  it('clears waiting on steer and preserves updates that arrived mid-steer', async () => {
    vi.useFakeTimers()
    const events: boolean[] = []
    const tracker = new AgyBackgroundWait({
      tailReader: null,
      settleMs: 100,
      onWaitingChange: (_id, waiting) => events.push(waiting),
    })

    tracker.onPromptStart('s-1', 1_000)
    tracker.onUpdate('s-1', msgChunk('Timer started.'), false)
    tracker.onUpdate('s-1', usageUpdate(1_100), false)
    await vi.advanceTimersByTimeAsync(100)
    expect(events).toEqual([true])

    // Steer accepted before any new chunks arrive -> exits waiting and resets step state.
    const gen1 = tracker.generationOf('s-1')
    tracker.onSteered('s-1', gen1)
    expect(events).toEqual([true, false])

    // Next reply finishes and enters waiting again.
    tracker.onUpdate('s-1', msgChunk('Answered follow-up.'), false)
    tracker.onUpdate('s-1', usageUpdate(1_300), false)
    await vi.advanceTimersByTimeAsync(100)
    expect(events).toEqual([true, false, true])

    // Mid-steer race: a chunk of the steered reply arrives before steer resolves.
    const gen2 = tracker.generationOf('s-1')
    tracker.onUpdate('s-1', msgChunk('Quick answer.'), false)
    tracker.onSteered('s-1', gen2)
    // Because sawOutput was preserved, even an unchanged usage_update still settles cleanly.
    tracker.onUpdate('s-1', usageUpdate(1_300), false)
    await vi.advanceTimersByTimeAsync(100)
    expect(events).toEqual([true, false, true, false, true])
    tracker.stop()
  })

  it('corroborates with transcript tail and falls back when usage_update is omitted', async () => {
    vi.useFakeTimers()
    const events: boolean[] = []
    let tail: AgyTranscriptTail | null = {
      stepIndex: 5,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      hasToolCalls: false,
    }
    const tracker = new AgyBackgroundWait({
      tailReader: async () => tail,
      settleMs: 100,
      fallbackMs: 500,
      onWaitingChange: (_id, waiting) => events.push(waiting),
    })

    // Baseline is step 5 from an earlier turn.
    tracker.onPromptStart('s-1', 1_000)
    await vi.advanceTimersByTimeAsync(0)

    // Still streaming step 6 (disk still at old step 5) -> fallback must NOT fire on stale step 5.
    tracker.onUpdate('s-1', msgChunk('Working...'), false)
    await vi.advanceTimersByTimeAsync(600)
    expect(events).toEqual([])

    // Fresh step 6 on disk has tool_calls -> neither usage_update nor fallback enters waiting.
    tail = { stepIndex: 6, type: 'PLANNER_RESPONSE', status: 'DONE', hasToolCalls: true }
    tracker.onUpdate('s-1', usageUpdate(1_200), false)
    await vi.advanceTimersByTimeAsync(200)
    expect(events).toEqual([])

    // Step 7 writes a tool-less DONE PLANNER_RESPONSE without sending usage_update -> fallback catches it.
    tracker.onUpdate('s-1', msgChunk('Waiting for timer.'), false)
    tail = { stepIndex: 7, type: 'PLANNER_RESPONSE', status: 'DONE', hasToolCalls: false }
    await vi.advanceTimersByTimeAsync(500)
    expect(events).toEqual([true])
    tracker.stop()
  })

  it('handles real agy 1.5.18 order where usage_update arrives before tool_call on Step 1', async () => {
    vi.useFakeTimers()
    const events: boolean[] = []
    let tail: AgyTranscriptTail | null = {
      stepIndex: 0,
      type: 'USER_INPUT',
      status: 'DONE',
      hasToolCalls: false,
    }
    const tracker = new AgyBackgroundWait({
      tailReader: async () => tail,
      settleMs: 300,
      fallbackMs: 1_500,
      onWaitingChange: (_id, waiting) => events.push(waiting),
    })

    tracker.onPromptStart('s-1', null)
    await vi.advanceTimersByTimeAsync(0)

    // Pre-step initial usage_update with used === 0 must not trigger waiting.
    tracker.onUpdate('s-1', usageUpdate(0), false)
    await vi.advanceTimersByTimeAsync(500)
    expect(events).toEqual([])

    // Step 1: thought -> usage_update -> tool_call (+15ms) -> tool_call_update(in_progress).
    tracker.onUpdate('s-1', thoughtChunk('Starting background command.'), false)
    tail = { stepIndex: 1, type: 'PLANNER_RESPONSE', status: 'DONE', hasToolCalls: true }
    tracker.onUpdate('s-1', usageUpdate(10_780), false)
    await vi.advanceTimersByTimeAsync(15)
    tracker.onUpdate('s-1', toolCall('call-1', 'run_command', 'in_progress'), false)
    await vi.advanceTimersByTimeAsync(11)
    tracker.onUpdate('s-1', toolUpdate('call-1', 'in_progress'), false)
    tail = { stepIndex: 2, type: 'GENERIC', status: 'RUNNING', hasToolCalls: false }
    await vi.advanceTimersByTimeAsync(3_500)
    expect(events).toEqual([])

    // Step 2: plain reply with no tool calls; sawTool from Step 1 must not leak.
    tracker.onUpdate('s-1', msgChunk('READY'), false)
    // Late in_progress update for Step 1's background command must not poison Step 2.
    tracker.onUpdate('s-1', toolUpdate('call-1', 'in_progress'), false)
    await vi.advanceTimersByTimeAsync(32)
    tracker.onUpdate('s-1', usageUpdate(11_029), false)

    // Transcript flushes Step 3 PLANNER_RESPONSE DONE before settleMs expires.
    await vi.advanceTimersByTimeAsync(150)
    tail = { stepIndex: 3, type: 'PLANNER_RESPONSE', status: 'DONE', hasToolCalls: false }
    await vi.advanceTimersByTimeAsync(150)
    expect(events).toEqual([true])
    expect(tracker.isWaiting('s-1')).toBe(true)
    tracker.stop()
  })

  it('handles chunkless tool steps before a tool-less reply in agy 1.5.18 order', async () => {
    vi.useFakeTimers()
    const events: boolean[] = []
    const tracker = new AgyBackgroundWait({
      tailReader: null,
      settleMs: 300,
      onWaitingChange: (_id, waiting) => events.push(waiting),
    })

    tracker.onPromptStart('s-1', null)
    tracker.onUpdate('s-1', usageUpdate(0), false)

    // Step 1: no thought or text chunk, only usage_update -> tool_call -> completed.
    tracker.onUpdate('s-1', usageUpdate(10_780), false)
    await vi.advanceTimersByTimeAsync(15)
    tracker.onUpdate('s-1', toolCall('call-1', 'manage_task', 'in_progress'), false)
    tracker.onUpdate('s-1', toolUpdate('call-1', 'completed'), false)
    await vi.advanceTimersByTimeAsync(500)
    expect(events).toEqual([])

    // Step 2: another chunkless tool step (usage_update -> tool_call).
    tracker.onUpdate('s-1', usageUpdate(11_000), false)
    await vi.advanceTimersByTimeAsync(15)
    tracker.onUpdate('s-1', toolCall('call-2', 'run_command', 'in_progress'), false)
    await vi.advanceTimersByTimeAsync(500)
    expect(events).toEqual([])

    // Step 3: final reply with no tool calls settles into waiting.
    tracker.onUpdate('s-1', msgChunk('Background job running.'), false)
    tracker.onUpdate('s-1', usageUpdate(11_250), false)
    await vi.advanceTimersByTimeAsync(300)
    expect(events).toEqual([true])
    tracker.stop()
  })

  it('retries when transcript.jsonl still shows a fresh non-planner step after usage_update and confirms once PLANNER_RESPONSE flushes', async () => {
    vi.useFakeTimers()
    const events: boolean[] = []
    let tail: AgyTranscriptTail | null = {
      stepIndex: 0,
      type: 'USER_INPUT',
      status: 'DONE',
      hasToolCalls: false,
    }
    const tracker = new AgyBackgroundWait({
      tailReader: async () => tail,
      settleMs: 300,
      retryDelaysMs: [200, 400, 800],
      onWaitingChange: (_id, waiting) => events.push(waiting),
    })

    tracker.onPromptStart('s-1', null)
    await vi.advanceTimersByTimeAsync(0)

    // Step 1 tool step leaves transcript at step 2 GENERIC RUNNING.
    tracker.onUpdate('s-1', thoughtChunk('Running task'), false)
    tracker.onUpdate('s-1', usageUpdate(10_780), false)
    await vi.advanceTimersByTimeAsync(15)
    tracker.onUpdate('s-1', toolCall('call-1', 'run_command', 'in_progress'), false)
    tail = { stepIndex: 2, type: 'GENERIC', status: 'RUNNING', hasToolCalls: false }

    // Step 2 reply emits usage_update before step 3 flushes to disk.
    tracker.onUpdate('s-1', msgChunk('READY'), false)
    tracker.onUpdate('s-1', usageUpdate(11_029), false)

    // At +300ms (initial check) and +500ms (retry 1), disk is still step 2 GENERIC RUNNING.
    await vi.advanceTimersByTimeAsync(300)
    expect(events).toEqual([])
    await vi.advanceTimersByTimeAsync(200)
    expect(events).toEqual([])

    // Step 3 flushes before retry 2 (+400ms later, total +900ms) -> confirms waiting.
    tail = { stepIndex: 3, type: 'PLANNER_RESPONSE', status: 'DONE', hasToolCalls: false }
    await vi.advanceTimersByTimeAsync(400)
    expect(events).toEqual([true])
    tracker.stop()
  })

  it('never marks waiting if flush retries exhaust on GENERIC, cancels retries on activity, and aborts immediately on non-terminal PLANNER_RESPONSE', async () => {
    vi.useFakeTimers()
    const events: boolean[] = []
    let reads = 0
    let tail: AgyTranscriptTail | null = {
      stepIndex: 0,
      type: 'USER_INPUT',
      status: 'DONE',
      hasToolCalls: false,
    }
    const tracker = new AgyBackgroundWait({
      tailReader: async () => {
        reads++
        return tail
      },
      settleMs: 100,
      retryDelaysMs: [100, 200],
      onWaitingChange: (_id, waiting) => events.push(waiting),
    })

    tracker.onPromptStart('s-1', 1_000)
    await vi.advanceTimersByTimeAsync(0)

    // Case 1: Tail remains fresh GENERIC through every retry -> never marks waiting.
    tail = { stepIndex: 2, type: 'GENERIC', status: 'DONE', hasToolCalls: false }
    tracker.onUpdate('s-1', msgChunk('Still working'), false)
    tracker.onUpdate('s-1', usageUpdate(1_200), false)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(events).toEqual([])

    // Case 2: Tail is a fresh PLANNER_RESPONSE with status !== DONE -> aborts immediately without retrying.
    const readsBeforeRunning = reads
    tail = { stepIndex: 3, type: 'PLANNER_RESPONSE', status: 'RUNNING', hasToolCalls: false }
    tracker.onUpdate('s-1', msgChunk('Streaming...'), false)
    tracker.onUpdate('s-1', usageUpdate(1_400), false)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(events).toEqual([])
    expect(reads - readsBeforeRunning).toBe(1)

    // Case 3: Retry scheduled on fresh SYSTEM_MESSAGE is cancelled immediately if a tool_call arrives.
    tail = { stepIndex: 4, type: 'SYSTEM_MESSAGE', status: 'DONE', hasToolCalls: false }
    tracker.onUpdate('s-1', msgChunk('Checking'), false)
    tracker.onUpdate('s-1', usageUpdate(1_600), false)
    await vi.advanceTimersByTimeAsync(100)
    // Now retry 1 is pending in 100ms; a new tool_call cancels it even if transcript later writes DONE.
    tracker.onUpdate('s-1', toolCall('c-next', 'run_command', 'in_progress'), false)
    tail = { stepIndex: 5, type: 'PLANNER_RESPONSE', status: 'DONE', hasToolCalls: false }
    await vi.advanceTimersByTimeAsync(500)
    expect(events).toEqual([])
    tracker.stop()
  })

  it('ignores initial used === 0 usage_update without output on both first and subsequent turns', async () => {
    vi.useFakeTimers()
    const events: boolean[] = []
    const tracker = new AgyBackgroundWait({
      tailReader: null,
      settleMs: 100,
      onWaitingChange: (_id, waiting) => events.push(waiting),
    })

    // First turn (currentUsed is null).
    tracker.onPromptStart('s-1', null)
    tracker.onUpdate('s-1', usageUpdate(0), false)
    await vi.advanceTimersByTimeAsync(300)
    expect(events).toEqual([])
    tracker.onPromptEnd('s-1')

    // Subsequent turn (currentUsed > 0, then agy emits initial used: 0).
    tracker.onPromptStart('s-1', 10_000)
    tracker.onUpdate('s-1', usageUpdate(0), false)
    await vi.advanceTimersByTimeAsync(300)
    expect(events).toEqual([])
    tracker.stop()
  })

  it('handles hidden suggest_next_message after usage_update followed by the final reply', async () => {
    vi.useFakeTimers()
    const events: boolean[] = []
    const tracker = new AgyBackgroundWait({
      tailReader: null,
      settleMs: 100,
      onWaitingChange: (_id, waiting) => events.push(waiting),
    })

    tracker.onPromptStart('s-1', 1_000)
    // Step 1: usage_update arrives before hidden tool_call.
    tracker.onUpdate('s-1', thoughtChunk('Suggesting next prompt.'), false)
    tracker.onUpdate('s-1', usageUpdate(1_200), false)
    await vi.advanceTimersByTimeAsync(15)
    tracker.onUpdate('s-1', toolCall('h-1', 'mcp_kettu_suggest_next_message', 'in_progress'), false)
    tracker.onUpdate('s-1', toolUpdate('h-1', 'completed'), false)
    await vi.advanceTimersByTimeAsync(300)
    expect(events).toEqual([])

    // Step 2: final reply with no tool calls enters waiting cleanly.
    tracker.onUpdate('s-1', msgChunk('Background task started.'), false)
    tracker.onUpdate('s-1', usageUpdate(1_400), false)
    await vi.advanceTimersByTimeAsync(100)
    expect(events).toEqual([true])
    tracker.stop()
  })

  it('falls back via transcript.jsonl when usage_update is omitted after a prior tool step', async () => {
    vi.useFakeTimers()
    const events: boolean[] = []
    let tail: AgyTranscriptTail | null = {
      stepIndex: 0,
      type: 'USER_INPUT',
      status: 'DONE',
      hasToolCalls: false,
    }
    const tracker = new AgyBackgroundWait({
      tailReader: async () => tail,
      settleMs: 100,
      fallbackMs: 500,
      retryDelaysMs: [100, 200],
      onWaitingChange: (_id, waiting) => events.push(waiting),
    })

    tracker.onPromptStart('s-1', null)
    await vi.advanceTimersByTimeAsync(0)

    // Step 1 (agy 1.5.18 order): usage_update -> tool_call; must NOT trigger fallback while running.
    tracker.onUpdate('s-1', thoughtChunk('Launching worker.'), false)
    tracker.onUpdate('s-1', usageUpdate(10_000), false)
    await vi.advanceTimersByTimeAsync(15)
    tracker.onUpdate('s-1', toolCall('c-1', 'invoke_subagent', 'in_progress'), false)
    tail = { stepIndex: 1, type: 'PLANNER_RESPONSE', status: 'DONE', hasToolCalls: true }
    await vi.advanceTimersByTimeAsync(1_000)
    expect(events).toEqual([])

    // Step 2: streams final reply, omits usage_update; fallback verifies fresh tool-less DONE tail.
    tail = { stepIndex: 2, type: 'GENERIC', status: 'DONE', hasToolCalls: false }
    tracker.onUpdate('s-1', msgChunk('Worker running.'), false)
    await vi.advanceTimersByTimeAsync(500)
    expect(events).toEqual([])
    // Transcript flushes step 3 during fallback retry window -> marks waiting.
    tail = { stepIndex: 3, type: 'PLANNER_RESPONSE', status: 'DONE', hasToolCalls: false }
    await vi.advanceTimersByTimeAsync(100)
    expect(events).toEqual([true])
    tracker.stop()
  })

  it('enters waiting when trailing SYSTEM_MESSAGE or GENERIC follows a fresh tool-less PLANNER_RESPONSE', async () => {
    vi.useFakeTimers()
    const events: boolean[] = []
    let tail: AgyTranscriptTail | null = {
      stepIndex: 0,
      type: 'USER_INPUT',
      status: 'DONE',
      hasToolCalls: false,
    }
    const tracker = new AgyBackgroundWait({
      tailReader: async () => tail,
      settleMs: 100,
      retryDelaysMs: [150, 300],
      onWaitingChange: (_id, waiting) => events.push(waiting),
    })

    tracker.onPromptStart('s-1', 1_000)
    await vi.advanceTimersByTimeAsync(0)

    // Case 1: trailing SYSTEM_MESSAGE (e.g. system reminder) after fresh tool-less DONE planner.
    tracker.onUpdate('s-1', msgChunk('Waiting for cron.'), false)
    tracker.onUpdate('s-1', usageUpdate(1_200), false)
    tail = {
      stepIndex: 3,
      type: 'SYSTEM_MESSAGE',
      status: 'DONE',
      hasToolCalls: false,
      latestPlanner: { stepIndex: 2, status: 'DONE', hasToolCalls: false },
    }
    // Gives one brief retry on SYSTEM_MESSAGE in case it is a wakeup about to stream.
    await vi.advanceTimersByTimeAsync(100)
    expect(events).toEqual([])
    await vi.advanceTimersByTimeAsync(150)
    expect(events).toEqual([true])

    // Wakeup clears waiting.
    tracker.onUpdate('s-1', msgChunk('Checked status, still waiting.'), false)
    expect(events).toEqual([true, false])

    // Case 2: trailing GENERIC after fresh tool-less DONE planner enters waiting cleanly.
    tracker.onUpdate('s-1', usageUpdate(1_400), false)
    tail = {
      stepIndex: 5,
      type: 'GENERIC',
      status: 'DONE',
      hasToolCalls: false,
      latestPlanner: { stepIndex: 4, status: 'DONE', hasToolCalls: false },
    }
    await vi.advanceTimersByTimeAsync(100)
    expect(events).toEqual([true, false, true])
    tracker.stop()
  })

  it('handles unchanged usage_update, active background fallback after slow flush, and multi-round wakeup loops', async () => {
    vi.useFakeTimers()
    const events: [boolean, string | undefined][] = []
    let activeBg = true
    let tail: AgyTranscriptTail | null = {
      stepIndex: 0,
      type: 'USER_INPUT',
      status: 'DONE',
      hasToolCalls: false,
    }
    const tracker = new AgyBackgroundWait({
      tailReader: async () => tail,
      hasActiveBackground: () => activeBg,
      settleMs: 100,
      fallbackMs: 500,
      retryDelaysMs: [100, 200],
      onWaitingChange: (_id, waiting, reason) => events.push([waiting, reason]),
    })

    tracker.onPromptStart('s-1', 1_000)
    await vi.advanceTimersByTimeAsync(0)

    // Round 1: agy 1.5.18 usage_update -> tool_call, then chunkless silent wait with unchanged `used`,
    // while disk stays on GENERIC RUNNING past retry window -> active background prevents infinite spin.
    tracker.onUpdate('s-1', usageUpdate(1_500), false)
    await vi.advanceTimersByTimeAsync(15)
    tracker.onUpdate('s-1', toolCall('c-mon', 'run_command', 'in_progress'), false)
    tail = { stepIndex: 2, type: 'GENERIC', status: 'RUNNING', hasToolCalls: false }

    // Next step emits usage_update with the SAME `used` (no text chunk) and no tool_call.
    tracker.onUpdate('s-1', usageUpdate(1_500), false)
    // Config-only window size change must still be ignored if tested separately; here size is unchanged.
    await vi.advanceTimersByTimeAsync(100 + 100 + 200)
    expect(events).toEqual([[true, undefined]])

    // Round 2: background notification wakes the session (reason: 'activity').
    tracker.onUpdate('s-1', thoughtChunk('60s notification arrived.'), false)
    expect(events).toEqual([
      [true, undefined],
      [false, 'activity'],
    ])
    tracker.onUpdate('s-1', usageUpdate(1_800), false)
    await vi.advanceTimersByTimeAsync(15)
    tracker.onUpdate('s-1', toolCall('c-check', 'manage_task', 'in_progress'), false)
    tracker.onUpdate('s-1', toolUpdate('c-check', 'completed'), false)

    // Agent decides to keep waiting silently after checking status -> emits only usage_update.
    tail = { stepIndex: 4, type: 'PLANNER_RESPONSE', status: 'DONE', hasToolCalls: false }
    tracker.onUpdate('s-1', usageUpdate(1_900), false)
    await vi.advanceTimersByTimeAsync(100)
    expect(events).toEqual([
      [true, undefined],
      [false, 'activity'],
      [true, undefined],
    ])

    // Round 3: user steers a message (reason: 'steer'), then background finishes and activeBg clears.
    const gen = tracker.generationOf('s-1')
    tracker.onSteered('s-1', gen)
    expect(events.at(-1)).toEqual([false, 'steer'])

    activeBg = false
    tracker.onUpdate('s-1', msgChunk('All finished.'), false)
    tail = { stepIndex: 5, type: 'GENERIC', status: 'DONE', hasToolCalls: false }
    tracker.onUpdate('s-1', usageUpdate(2_100), false)
    await vi.advanceTimersByTimeAsync(600)
    // Without active background tasks and without a fresh PLANNER_RESPONSE DONE, stays conservative.
    expect(events).toHaveLength(4)
    tracker.stop()
  })
})
