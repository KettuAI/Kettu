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
})
