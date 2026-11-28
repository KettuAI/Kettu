import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostActivitySnapshot } from '@shared/host-control'
import {
  DEFAULT_CHOICES,
  LIVE_ACTIVITY_V1,
  LIVE_ACTIVITY_V2,
  type DevicePush,
} from '@shared/remote/push'
import { Notifier, type PushJob } from './notifier'

const TOKEN = 'a1'.repeat(32)
const START_TOKEN = 'b2'.repeat(32)
const UPDATE_TOKEN = 'c3'.repeat(32)

const EMPTY_ACTIVITY: HostActivitySnapshot = {
  running: [],
  error: [],
  ended: [],
  limit: null,
  waitingMeta: {},
}

function makeDevice(
  overrides: Partial<DevicePush> = {},
  id = 'phone',
): { id: string; push: DevicePush } {
  return {
    id,
    push: {
      target: {
        apns: { token: TOKEN, environment: 'sandbox' },
        activity: { start: START_TOKEN, version: LIVE_ACTIVITY_V2 },
      },
      choices: { ...DEFAULT_CHOICES, onlyAway: false },
      ...overrides,
    },
  }
}

describe('Notifier Live Activity push guards and expiry cleanup', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('suppresses remote push-to-start while a device is in the foreground and resumes once backgrounded', () => {
    vi.useFakeTimers()
    let inForeground = true
    const device = makeDevice()
    const jobs: PushJob[] = []
    const notifier = new Notifier({
      devices: () => [device],
      showing: () => false,
      foreground: (id) => id === device.id && inForeground,
      send: (job) => jobs.push(job),
      mergeMs: 10,
    })

    const now = Date.now()
    notifier.setActivity({
      ...EMPTY_ACTIVITY,
      running: [
        {
          sessionId: 's-run',
          agentId: 'claude-code',
          title: 'Build feature',
          turnStartedAt: now,
          parentId: null,
        },
      ],
    })
    vi.advanceTimersByTime(20)
    expect(jobs.filter((j) => j.type === 'activity')).toEqual([])

    // Waiting permission requests also must not push-to-start while the device is foregrounded.
    notifier.attention({
      kind: 'permission',
      sessionId: 's-run',
      title: 'Build feature',
      body: 'Wants to run pnpm test',
      requestId: 'req-1',
      inFront: false,
      devices: [],
    })
    notifier.setWaiting({ 's-run': ['req-1'] })
    vi.advanceTimersByTime(20)
    expect(jobs.filter((j) => j.type === 'activity')).toEqual([])

    // Once backgrounded, re-evaluating the device resumes with a single remote start.
    inForeground = false
    notifier.deviceChanged()
    vi.advanceTimersByTime(20)
    const activityJobs = jobs.filter((j) => j.type === 'activity')
    expect(activityJobs).toHaveLength(1)
    expect(activityJobs[0]).toMatchObject({
      type: 'activity',
      action: 'start',
      count: 1,
      payload: { kind: 'waiting', count: 1, sessionId: 's-run' },
    })

    notifier.stop()
  })

  it('still sends updates and end for an already-active Live Activity even while foregrounded', () => {
    vi.useFakeTimers()
    const device = makeDevice({
      target: {
        apns: { token: TOKEN, environment: 'sandbox' },
        activity: { start: START_TOKEN, update: UPDATE_TOKEN, version: LIVE_ACTIVITY_V2 },
      },
    })
    const jobs: PushJob[] = []
    const notifier = new Notifier({
      devices: () => [device],
      showing: () => false,
      foreground: () => true,
      send: (job) => jobs.push(job),
      mergeMs: 10,
    })

    const now = Date.now()
    notifier.setActivity({
      ...EMPTY_ACTIVITY,
      running: [
        {
          sessionId: 's-run',
          agentId: 'codex',
          title: 'Investigate test',
          turnStartedAt: now,
          parentId: null,
        },
      ],
    })
    vi.advanceTimersByTime(20)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({
      type: 'activity',
      action: 'update',
      payload: { kind: 'running', sessionId: 's-run' },
    })

    notifier.setActivity(EMPTY_ACTIVITY)
    vi.advanceTimersByTime(20)
    expect(jobs).toHaveLength(2)
    expect(jobs[1]).toMatchObject({ type: 'activity', action: 'end', count: 0 })

    notifier.stop()
  })

  it('never push-to-starts a new Live Activity for settled states (turn-ended, error, limit)', () => {
    vi.useFakeTimers()
    const device = makeDevice()
    const jobs: PushJob[] = []
    const notifier = new Notifier({
      devices: () => [device],
      showing: () => false,
      foreground: () => false,
      send: (job) => jobs.push(job),
      mergeMs: 10,
    })

    const now = Date.now()
    notifier.setActivity({
      ...EMPTY_ACTIVITY,
      ended: [
        {
          sessionId: 's-done',
          agentId: 'claude-code',
          title: 'Finished task',
          endedAt: now - 5_000,
        },
      ],
    })
    vi.advanceTimersByTime(20)
    expect(jobs).toEqual([])

    notifier.setActivity({
      ...EMPTY_ACTIVITY,
      error: [
        {
          sessionId: 's-err',
          agentId: 'codex',
          title: 'Failed task',
          body: 'Exited with code 1',
          endedAt: now - 5_000,
        },
      ],
    })
    vi.advanceTimersByTime(20)
    expect(jobs).toEqual([])

    notifier.setActivity({
      ...EMPTY_ACTIVITY,
      limit: {
        agentId: 'claude-code',
        label: '5-hour',
        resetsAt: now + 30 * 60_000,
      },
    })
    vi.advanceTimersByTime(20)
    expect(jobs).toEqual([])

    notifier.stop()
  })

  it('updates an already-active Live Activity to turn-ended and auto-ends it after 2 minutes', () => {
    vi.useFakeTimers()
    const device = makeDevice({
      target: {
        apns: { token: TOKEN, environment: 'sandbox' },
        activity: { start: START_TOKEN, update: UPDATE_TOKEN, version: LIVE_ACTIVITY_V2 },
      },
    })
    const jobs: PushJob[] = []
    const notifier = new Notifier({
      devices: () => [device],
      showing: () => false,
      send: (job) => jobs.push(job),
      mergeMs: 10,
    })

    const now = Date.now()
    notifier.setActivity({
      ...EMPTY_ACTIVITY,
      ended: [
        {
          sessionId: 's-done',
          agentId: 'claude-code',
          title: 'Finished task',
          endedAt: now,
        },
      ],
    })
    vi.advanceTimersByTime(20)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({
      type: 'activity',
      action: 'update',
      payload: { kind: 'turn-ended', sessionId: 's-done' },
    })

    // Still active just before the 2-minute window elapses.
    vi.advanceTimersByTime(2 * 60_000 - 30)
    expect(jobs).toHaveLength(1)

    // Without any further host event, the expiry timer triggers an automatic end push.
    vi.advanceTimersByTime(30)
    expect(jobs).toHaveLength(2)
    expect(jobs[1]).toMatchObject({
      type: 'activity',
      action: 'end',
      count: 0,
      sessionId: null,
      title: null,
    })

    notifier.stop()
  })

  it('auto-ends an active error Live Activity after 15 minutes with no further events', () => {
    vi.useFakeTimers()
    const device = makeDevice({
      target: {
        apns: { token: TOKEN, environment: 'sandbox' },
        activity: { start: START_TOKEN, update: UPDATE_TOKEN, version: LIVE_ACTIVITY_V2 },
      },
    })
    const jobs: PushJob[] = []
    const notifier = new Notifier({
      devices: () => [device],
      showing: () => false,
      send: (job) => jobs.push(job),
      mergeMs: 10,
    })

    const now = Date.now()
    notifier.setActivity({
      ...EMPTY_ACTIVITY,
      error: [
        {
          sessionId: 's-err',
          agentId: 'codex',
          title: 'Sync job',
          body: 'Command failed',
          endedAt: now,
        },
      ],
    })
    vi.advanceTimersByTime(20)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({
      type: 'activity',
      action: 'update',
      payload: { kind: 'error', sessionId: 's-err' },
    })

    vi.advanceTimersByTime(15 * 60_000 - 30)
    expect(jobs).toHaveLength(1)

    vi.advanceTimersByTime(30)
    expect(jobs).toHaveLength(2)
    expect(jobs[1]).toMatchObject({ type: 'activity', action: 'end', count: 0 })

    notifier.stop()
  })

  it('chains staggered expiry windows and auto-ends reached limit states at resetsAt', () => {
    vi.useFakeTimers()
    const device = makeDevice({
      target: {
        apns: { token: TOKEN, environment: 'sandbox' },
        activity: { start: START_TOKEN, update: UPDATE_TOKEN, version: LIVE_ACTIVITY_V2 },
      },
    })
    const jobs: PushJob[] = []
    const notifier = new Notifier({
      devices: () => [device],
      showing: () => false,
      send: (job) => jobs.push(job),
      mergeMs: 10,
    })

    const now = Date.now()
    // Error expires in 10 seconds, exposing the reached limit which resets in 30 seconds.
    notifier.setActivity({
      ...EMPTY_ACTIVITY,
      error: [
        {
          sessionId: 's-err',
          agentId: 'codex',
          title: 'Older error',
          endedAt: now - (15 * 60_000 - 10_000),
        },
      ],
      limit: {
        agentId: 'codex',
        label: '5-hour',
        resetsAt: now + 30_000,
      },
    })
    vi.advanceTimersByTime(20)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({
      type: 'activity',
      action: 'update',
      payload: { kind: 'error', sessionId: 's-err' },
    })

    // At +10s (+mergeMs), the error expires and transitions to limit.
    vi.advanceTimersByTime(10_000)
    expect(jobs).toHaveLength(2)
    expect(jobs[1]).toMatchObject({
      type: 'activity',
      action: 'update',
      payload: { kind: 'limit', agentId: 'codex', label: '5-hour' },
    })

    // At +30s (+mergeMs), the limit resets and sends end automatically.
    vi.advanceTimersByTime(20_000)
    expect(jobs).toHaveLength(3)
    expect(jobs[2]).toMatchObject({ type: 'activity', action: 'end', count: 0 })

    notifier.stop()
  })

  it('clears expiry timers cleanly on stop() with no dangling timers left behind', () => {
    vi.useFakeTimers()
    const device = makeDevice({
      target: {
        apns: { token: TOKEN, environment: 'sandbox' },
        activity: { start: START_TOKEN, update: UPDATE_TOKEN, version: LIVE_ACTIVITY_V2 },
      },
    })
    const jobs: PushJob[] = []
    const notifier = new Notifier({
      devices: () => [device],
      showing: () => false,
      send: (job) => jobs.push(job),
      mergeMs: 10,
    })

    const now = Date.now()
    notifier.setActivity({
      ...EMPTY_ACTIVITY,
      ended: [
        {
          sessionId: 's-done',
          agentId: 'claude-code',
          title: 'Finished task',
          endedAt: now,
        },
      ],
    })
    vi.advanceTimersByTime(20)
    expect(jobs).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(1)

    notifier.stop()
    expect(vi.getTimerCount()).toBe(0)

    vi.advanceTimersByTime(20 * 60_000)
    expect(jobs).toHaveLength(1)
  })

  it('用户回到电脑前时对开启 onlyAway 的后台设备收尾，但不干扰正在前台查看的手机', () => {
    vi.useFakeTimers()
    let inForeground = false
    const device = makeDevice({
      choices: { ...DEFAULT_CHOICES, onlyAway: true },
      target: {
        apns: { token: TOKEN, environment: 'sandbox' },
        activity: { start: START_TOKEN, update: UPDATE_TOKEN, version: LIVE_ACTIVITY_V2 },
      },
    })
    const jobs: PushJob[] = []
    const notifier = new Notifier({
      devices: () => [device],
      showing: () => false,
      foreground: () => inForeground,
      send: (job) => jobs.push(job),
      mergeMs: 10,
    })

    // 离开电脑时，后台手机正常更新运行中灵动岛。
    notifier.setPresent(false)
    notifier.setActivity({
      ...EMPTY_ACTIVITY,
      running: [
        {
          sessionId: 's-1',
          agentId: 'codex',
          title: 'Run checks',
          turnStartedAt: Date.now(),
          parentId: null,
        },
      ],
    })
    vi.advanceTimersByTime(20)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ type: 'activity', action: 'update' })

    // 手机切到前台时用户回到电脑前：不误发 end 干扰本地灵动岛。
    inForeground = true
    notifier.setPresent(true)
    vi.advanceTimersByTime(20)
    expect(jobs).toHaveLength(1)

    // 手机退到后台后，主机自动对残留活动发 end 收尾。
    inForeground = false
    notifier.deviceChanged()
    vi.advanceTimersByTime(20)
    expect(jobs).toHaveLength(2)
    expect(jobs[1]).toMatchObject({ type: 'activity', action: 'end', count: 0 })

    notifier.stop()
  })

  it('sends only waiting and end Live Activity pushes to legacy devices without v2 capability', () => {
    vi.useFakeTimers()
    const legacy = makeDevice({
      target: {
        apns: { token: TOKEN, environment: 'sandbox' },
        activity: { start: START_TOKEN },
      },
    })
    const legacyV1 = makeDevice(
      {
        target: {
          apns: { token: TOKEN, environment: 'sandbox' },
          activity: { start: START_TOKEN, version: LIVE_ACTIVITY_V1 },
        },
        choices: { ...DEFAULT_CHOICES, onlyAway: false, liveActivityProgress: true },
      },
      'phone-v1',
    )
    const jobs: PushJob[] = []
    const notifier = new Notifier({
      devices: () => [legacy, legacyV1],
      showing: () => false,
      foreground: () => false,
      send: (job) => jobs.push(job),
      mergeMs: 10,
    })

    const now = Date.now()
    // Running, error, limit and turn-ended states must send zero activity pushes to legacy devices.
    notifier.setActivity({
      ...EMPTY_ACTIVITY,
      running: [
        {
          sessionId: 's-run',
          agentId: 'claude-code',
          title: 'Running task',
          turnStartedAt: now,
          parentId: null,
        },
      ],
      error: [
        {
          sessionId: 's-err',
          agentId: 'codex',
          title: 'Errored task',
          endedAt: now,
        },
      ],
      ended: [
        {
          sessionId: 's-done',
          agentId: 'claude-code',
          title: 'Done task',
          endedAt: now,
        },
      ],
      limit: {
        agentId: 'claude-code',
        label: '5-hour',
        resetsAt: now + 60_000,
      },
    })
    vi.advanceTimersByTime(20)
    expect(jobs.filter((j) => j.type === 'activity')).toEqual([])

    // Waiting permission request triggers a legacy-compatible waiting start with count > 0.
    notifier.attention({
      kind: 'permission',
      sessionId: 's-run',
      title: 'Running task',
      body: 'Wants to run pnpm test',
      requestId: 'req-1',
      inFront: false,
      devices: [],
    })
    notifier.setWaiting({ 's-run': ['req-1'] })
    vi.advanceTimersByTime(20)
    const startJobs = jobs.filter((j) => j.type === 'activity')
    expect(startJobs).toHaveLength(2)
    for (const startJob of startJobs) {
      expect(startJob).toMatchObject({
        type: 'activity',
        action: 'start',
        count: 1,
        payload: { kind: 'waiting', count: 1, sessionId: 's-run' },
      })
    }

    // Once the device reports an update token and waiting clears, legacy devices get `end`
    // even while the session is still running (never a v2 `running` update).
    legacy.push.target!.activity = { start: START_TOKEN, update: UPDATE_TOKEN }
    legacyV1.push.target!.activity = {
      start: START_TOKEN,
      update: UPDATE_TOKEN,
      version: LIVE_ACTIVITY_V1,
    }
    notifier.setWaiting({})
    vi.advanceTimersByTime(20)
    const endJobs = jobs.filter((j) => j.type === 'activity' && j.action === 'end')
    expect(endJobs).toHaveLength(2)
    for (const endJob of endJobs) {
      expect(endJob).toMatchObject({ type: 'activity', action: 'end', count: 0 })
    }

    // Re-validating a non-waiting job against a legacy device returns false.
    expect(
      notifier.isJobValid({
        deviceId: legacy.id,
        subject: 'activity',
        type: 'activity',
        action: 'start',
        count: 0,
        sessionId: 's-run',
        title: 'Running task',
        payload: { kind: 'running', sessionId: 's-run', title: 'Running task' },
      }),
    ).toBe(false)

    notifier.stop()
  })

  it('respects liveActivityProgress opt-out on v2 devices and resumes when re-enabled', () => {
    vi.useFakeTimers()
    const device = makeDevice({
      choices: { ...DEFAULT_CHOICES, onlyAway: false, liveActivityProgress: false },
    })
    const jobs: PushJob[] = []
    const notifier = new Notifier({
      devices: () => [device],
      showing: () => false,
      foreground: () => false,
      send: (job) => jobs.push(job),
      mergeMs: 10,
    })

    notifier.setActivity({
      ...EMPTY_ACTIVITY,
      running: [
        {
          sessionId: 's-run',
          agentId: 'claude-code',
          title: 'Opted-out running task',
          turnStartedAt: Date.now(),
          parentId: null,
        },
      ],
    })
    vi.advanceTimersByTime(20)
    expect(jobs).toEqual([])

    device.push.choices = { ...device.push.choices, liveActivityProgress: true }
    notifier.deviceChanged()
    vi.advanceTimersByTime(20)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({
      type: 'activity',
      action: 'start',
      payload: { kind: 'running', sessionId: 's-run' },
    })

    notifier.stop()
  })

  it('does not spam push-to-start while awaiting update token, and recovers if start was not sent', () => {
    vi.useFakeTimers()
    const device = makeDevice()
    const jobs: PushJob[] = []
    const notifier = new Notifier({
      devices: () => [device],
      showing: () => false,
      foreground: () => false,
      send: (job) => jobs.push(job),
      mergeMs: 10,
    })

    const now = Date.now()
    notifier.setActivity({
      ...EMPTY_ACTIVITY,
      running: [
        {
          sessionId: 's-1',
          agentId: 'claude-code',
          title: 'Step 1',
          turnStartedAt: now,
          plan: { done: 1, total: 3, current: 'Step 1' },
          parentId: null,
        },
      ],
    })
    vi.advanceTimersByTime(20)
    expect(jobs).toHaveLength(1)

    // Subsequent updates while still awaiting the update token must not fire extra push-to-start bursts.
    for (let step = 2; step <= 4; step++) {
      notifier.setActivity({
        ...EMPTY_ACTIVITY,
        running: [
          {
            sessionId: 's-1',
            agentId: 'claude-code',
            title: `Step ${step}`,
            turnStartedAt: now,
            plan: { done: step, total: 4, current: `Step ${step}` },
            parentId: null,
          },
        ],
      })
      vi.advanceTimersByTime(20)
    }
    expect(jobs).toHaveLength(1)

    // When PushSender confirms the start was never sent to APNs, awaitingToken clears so a new start works.
    notifier.activityStartNotSent(jobs[0]!)
    notifier.deviceChanged()
    vi.advanceTimersByTime(20)
    expect(jobs).toHaveLength(2)
    expect(jobs[1]).toMatchObject({ type: 'activity', action: 'start' })

    // A stale callback for the earlier start job must not clear the newer start's awaitingToken.
    notifier.activityStartNotSent(jobs[0]!)
    notifier.deviceChanged()
    vi.advanceTimersByTime(20)
    expect(jobs).toHaveLength(2)

    notifier.stop()
  })
})
