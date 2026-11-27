import type * as acp from '@agentclientprotocol/sdk/unstable'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgyCommands, formatScheduleDuration } from './agy-commands'

afterEach(() => {
  vi.useRealTimers()
})

function toolUpdate(
  toolCallId: string,
  name: string,
  status: acp.ToolCallStatus,
  rawInput?: Record<string, unknown>,
  text?: string,
): acp.ToolCallUpdate {
  return {
    toolCallId,
    name,
    title: `Run ${name}`,
    status,
    ...(rawInput ? { rawInput } : {}),
    ...(text !== undefined
      ? { content: [{ type: 'content', content: { type: 'text', text } }] }
      : {}),
  } as unknown as acp.ToolCallUpdate
}

describe('AgyCommands tracker', () => {
  it('formats compact schedule durations cleanly', () => {
    expect(formatScheduleDuration(45)).toBe('45s')
    expect(formatScheduleDuration(60)).toBe('1m')
    expect(formatScheduleDuration(90)).toBe('1m 30s')
    expect(formatScheduleDuration(3600)).toBe('1h')
    expect(formatScheduleDuration(5400)).toBe('1h 30m')
  })

  it('tracks run_command with NotificationTimeoutSeconds as a monitor and clears it on manage_task kill', () => {
    const tracker = new AgyCommands()
    const start = 10_000

    tracker.follow(
      toolUpdate(
        'cmd-mon',
        'run_command',
        'in_progress',
        {
          CommandLine: 'pnpm build',
          toolSummary: 'Build workspace',
          NotificationTimeoutSeconds: 60,
          WaitMsBeforeAsync: 500,
        },
        'Tool is running as a background task with task id: conv-1/task-133',
      ),
      true,
      start,
    )

    expect(tracker.hasActiveBackground).toBe(true)
    expect(tracker.scheduledCount).toBe(0)
    expect(tracker.setWaiting(true, start + 500)).toBe(true)
    expect(tracker.running).toBe(true)
    expect(tracker.tasks()).toEqual([
      {
        id: 'cmd-mon',
        kind: 'monitor',
        title: 'Build workspace',
        command: 'pnpm build',
        status: 'running',
        startedAt: start,
        endedAt: null,
        summary: null,
        entryId: 't:cmd-mon',
        schedule: {
          mode: 'timeout',
          durationSeconds: 60,
          fireAt: start + 60_000,
        },
      },
    ])

    // Failed kill does not clear the running monitor.
    tracker.follow(
      toolUpdate('kill-fail', 'manage_task', 'in_progress', {
        Action: 'kill',
        TaskId: 'conv-1/task-133',
      }),
      true,
      start + 10_000,
    )
    expect(
      tracker.follow(
        toolUpdate('kill-fail', 'manage_task', 'failed', undefined, 'cannot kill task'),
        true,
        start + 10_100,
      ),
    ).toBe(false)
    expect(tracker.running).toBe(true)

    // Successful kill via short or full TaskId transitions the monitor to stopped.
    tracker.follow(
      toolUpdate('kill-ok', 'manage_task', 'in_progress', {
        Action: 'kill',
        TaskId: 'conv-1/task-133',
      }),
      true,
      start + 20_000,
    )
    expect(
      tracker.follow(
        toolUpdate(
          'kill-ok',
          'manage_task',
          'completed',
          undefined,
          'Task "conv-1/task-133" cancelled.',
        ),
        true,
        start + 20_100,
      ),
    ).toBe(true)
    expect(tracker.running).toBe(false)
    expect(tracker.hasActiveBackground).toBe(false)
    expect(tracker.tasks()).toMatchObject([
      {
        id: 'cmd-mon',
        kind: 'monitor',
        status: 'stopped',
        endedAt: start + 20_100,
        summary: 'Cancelled',
      },
    ])
  })

  it('tracks one-shot schedule timers with countdown, expires them automatically, and cancels early on TimerCondition', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
    let changes = 0
    const tracker = new AgyCommands({
      onChange: () => {
        changes++
      },
    })

    // Case 1: immediate completed registration (returns immediately while armed in background).
    tracker.follow(
      toolUpdate('sched-1', 'schedule', 'in_progress', {
        DurationSeconds: 10,
        TimerCondition: 'never',
        Prompt: 'Check CI status after 10 seconds',
      }),
      true,
      100_000,
    )
    tracker.follow(toolUpdate('sched-1', 'schedule', 'completed'), true, 100_050)
    expect(tracker.scheduledCount).toBe(1)
    expect(tracker.hasActiveBackground).toBe(true)
    expect(tracker.setWaiting(true, 100_100)).toBe(true)
    expect(tracker.tasks()).toEqual([
      {
        id: 'sched-1',
        kind: 'monitor',
        title: 'Check CI status after 10 seconds',
        command: 'Timer: 10s',
        status: 'running',
        startedAt: 100_000,
        endedAt: null,
        summary: null,
        entryId: 't:sched-1',
        schedule: {
          mode: 'timer',
          durationSeconds: 10,
          fireAt: 110_000,
          condition: 'never',
        },
      },
    ])

    // Wakeup before expiry does NOT cancel a `TimerCondition: 'never'` timer.
    expect(tracker.onWakeup(103_000)).toBe(false)
    expect(tracker.scheduledCount).toBe(1)

    // Advancing past fireAt + grace sweeps the expired timer cleanly.
    await vi.advanceTimersByTimeAsync(11_500)
    expect(changes).toBe(1)
    expect(tracker.scheduledCount).toBe(0)
    expect(tracker.hasActiveBackground).toBe(false)
    expect(tracker.tasks()).toMatchObject([{ id: 'sched-1', status: 'completed' }])

    // Case 2: TimerCondition: 'any' cancels early on wakeup, and sender-specific condition cancels on matching sender.
    const now2 = Date.now()
    tracker.follow(
      toolUpdate('sched-any', 'schedule', 'in_progress', {
        DurationSeconds: 300,
        TimerCondition: 'any',
        Prompt: 'Wait for any sub-agent',
      }),
      true,
      now2,
    )
    tracker.follow(
      toolUpdate('sched-sub', 'schedule', 'in_progress', {
        DurationSeconds: 300,
        TimerCondition: 'child-42',
        Prompt: 'Wait for child 42',
      }),
      true,
      now2,
    )
    tracker.setWaiting(true, now2 + 100)
    expect(tracker.scheduledCount).toBe(2)

    // A non-matching sender cancels `any` but leaves `child-42` running.
    expect(tracker.onSenderEvent('child-99', now2 + 500)).toBe(true)
    expect(tracker.scheduledCount).toBe(1)
    expect(tracker.tasks().find((t) => t.id === 'sched-any')?.status).toBe('stopped')
    expect(tracker.tasks().find((t) => t.id === 'sched-sub')?.status).toBe('running')

    // Matching sender cancels `child-42` too.
    expect(tracker.onSenderEvent('child-42', now2 + 1_000)).toBe(true)
    expect(tracker.scheduledCount).toBe(0)
    expect(tracker.tasks().find((t) => t.id === 'sched-sub')?.status).toBe('stopped')
    tracker.dispose()
  })

  it('carries IsDaemon cron jobs past turn end, drops non-daemon schedules on turn end, and reconciles manage_task list', () => {
    const tracker = new AgyCommands()
    const t0 = 50_000

    tracker.follow(
      toolUpdate('cron-daemon', 'schedule', 'in_progress', {
        CronExpression: '*/30 * * * *',
        IsDaemon: true,
        MaxIterations: 10,
        Prompt: 'Patrol incoming issues every 30 minutes',
      }),
      true,
      t0,
    )
    tracker.follow(
      toolUpdate('timer-ephemeral', 'schedule', 'in_progress', {
        DurationSeconds: 120,
        Prompt: 'Check PR CI',
      }),
      true,
      t0,
    )
    expect(tracker.scheduledCount).toBe(2)

    // Ending the turn keeps only the IsDaemon cron carried forward; non-daemon timer is dropped.
    expect(tracker.turnEnded(false, t0 + 5_000)).toBe(true)
    expect(tracker.scheduledCount).toBe(1)
    expect(tracker.running).toBe(true)
    expect(tracker.tasks()).toEqual([
      {
        id: 'cron-daemon',
        kind: 'monitor',
        title: 'Patrol incoming issues every 30 minutes',
        command: 'Cron: */30 * * * * (max 10)',
        status: 'running',
        startedAt: t0,
        endedAt: null,
        summary: null,
        entryId: 't:cron-daemon',
        schedule: {
          mode: 'cron',
          cron: '*/30 * * * *',
          daemon: true,
          maxIterations: 10,
        },
      },
    ])

    // manage_task(list) binds the agy taskId by matching cron expression.
    tracker.follow(
      toolUpdate('list-1', 'manage_task', 'in_progress', { Action: 'list' }),
      true,
      t0 + 10_000,
    )
    tracker.follow(
      toolUpdate(
        'list-1',
        'manage_task',
        'completed',
        { Action: 'list' },
        'You have 1 background task(s) currently running:\n[{"taskId":"conv-1/task-2939","toolName":"schedule","description":"Cron: */30 * * * *, Prompt: Patrol"}]',
      ),
      true,
      t0 + 10_100,
    )

    // Now manage_task(kill) with that taskId cleanly stops the daemon cron even between turns.
    tracker.follow(
      toolUpdate('kill-cron', 'manage_task', 'in_progress', {
        Action: 'kill',
        TaskId: 'conv-1/task-2939',
      }),
      true,
      t0 + 15_000,
    )
    expect(
      tracker.follow(
        toolUpdate(
          'kill-cron',
          'manage_task',
          'completed',
          undefined,
          'Task "conv-1/task-2939" cancelled.',
        ),
        true,
        t0 + 15_100,
      ),
    ).toBe(true)
    expect(tracker.scheduledCount).toBe(0)
    expect(tracker.running).toBe(false)
    expect(tracker.tasks()).toMatchObject([{ id: 'cron-daemon', status: 'stopped' }])
  })
})
