import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CHOICES, type DevicePush, type NotificationChoices } from '@shared/remote/push'
import { Notifier, type Attention, type NotifierDevice, type PushJob } from './notifier'

const TOKEN = 'a1'.repeat(32)

function device(
  id: string,
  choices: Partial<NotificationChoices> = {},
  activity?: NonNullable<DevicePush['target']>['activity'],
): NotifierDevice {
  return {
    id,
    push: {
      target: { apns: { token: TOKEN, environment: 'sandbox' }, ...(activity ? { activity } : {}) },
      choices: { ...DEFAULT_CHOICES, ...choices },
    },
  }
}

function setup(devices: NotifierDevice[], showing: [string, string][] = []) {
  const sent: PushJob[] = []
  const notifier = new Notifier({
    devices: () => devices,
    showing: (deviceId, sessionId) => showing.some(([d, s]) => d === deviceId && s === sessionId),
    send: (job) => sent.push(job),
    mergeMs: 100,
  })
  const settle = () => vi.advanceTimersByTime(100)
  return { notifier, sent, settle }
}

const permission = (sessionId: string, requestId: string, extra: Partial<Attention> = {}) =>
  ({
    kind: 'permission',
    sessionId,
    title: 'Fix the login form',
    body: 'Wants to run pnpm test',
    requestId,
    inFront: false,
    devices: [],
    ...extra,
  }) satisfies Attention

const ended = (sessionId: string, extra: Partial<Attention> = {}): Attention => ({
  kind: 'turn-ended',
  sessionId,
  title: 'Done: Fix the login form',
  body: 'All tests pass.',
  inFront: false,
  devices: [],
  ...extra,
})

const alerts = (sent: PushJob[]) =>
  sent.filter((job) => job.type === 'alert').map((job) => [job.deviceId, job.subject])

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('a request that waits', () => {
  it('notifies every device that wants it, with its answers', () => {
    const allow = { optionId: 'allow', label: 'Allow' }
    const t = setup([device('phone'), device('pad', { permission: false })])
    t.notifier.setWaiting({ s1: ['r1'] })
    t.notifier.attention(permission('s1', 'r1', { actions: { allow } }))
    t.settle()
    expect(t.sent.filter((job) => job.type === 'alert')).toEqual([
      {
        deviceId: 'phone',
        subject: 's1',
        type: 'alert',
        event: { kind: 'permission', sessionId: 's1', requestId: 'r1', actions: { allow } },
        title: 'Fix the login form',
        body: 'Wants to run pnpm test',
      },
    ])
  })

  it('skips a device that shows the session in front, then or now, and a session it muted', () => {
    const t = setup(
      [device('phone'), device('pad'), device('mini', { muted: ['s1'] })],
      [['pad', 's1']],
    )
    t.notifier.setWaiting({ s1: ['r1'] })
    t.notifier.attention(permission('s1', 'r1', { inFront: true, devices: ['phone'] }))
    t.settle()
    expect(alerts(t.sent)).toEqual([])
  })

  it('is withdrawn once it is answered and nothing else in its session waits', () => {
    const t = setup([device('phone')])
    t.notifier.setWaiting({ s1: ['r1', 'r2'] })
    t.notifier.attention(permission('s1', 'r2'))
    t.settle()
    t.notifier.setWaiting({ s1: ['r2'] })
    expect(t.sent.filter((job) => job.type === 'background')).toEqual([])
    t.notifier.setWaiting({})
    expect(t.sent.filter((job) => job.type === 'background')).toEqual([
      {
        deviceId: 'phone',
        subject: 's1',
        type: 'background',
        event: { kind: 'withdraw', sessionId: 's1' },
      },
    ])
  })

  it('is never sent when it was answered before its notification left', () => {
    const t = setup([device('phone')])
    t.notifier.setWaiting({ s1: ['r1'] })
    t.notifier.attention(permission('s1', 'r1'))
    t.notifier.setWaiting({})
    t.settle()
    expect(t.sent).toEqual([])
  })

  it("merges a session's notifications into the latest", () => {
    const t = setup([device('phone')])
    t.notifier.setWaiting({ s1: ['r1', 'r2'] })
    t.notifier.attention(permission('s1', 'r1'))
    t.notifier.attention(permission('s1', 'r2', { body: 'Wants to edit a.ts' }))
    t.settle()
    const sent = t.sent.filter((job) => job.type === 'alert')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ body: 'Wants to edit a.ts', event: { requestId: 'r2' } })
  })
})

describe('a turn that ended', () => {
  it('notifies only when no window or device showed its session', () => {
    const t = setup([device('phone'), device('pad', { turnEnded: false })])
    t.notifier.attention(ended('s1', { inFront: true }))
    t.notifier.attention(ended('s2'))
    t.settle()
    expect(alerts(t.sent)).toEqual([['phone', 's2']])
  })

  it('is withdrawn once its session is seen', () => {
    const t = setup([device('phone')])
    t.notifier.attention(ended('s1'))
    t.settle()
    t.notifier.seen('s1')
    expect(t.sent.at(-1)).toEqual({
      deviceId: 'phone',
      subject: 's1',
      type: 'background',
      event: { kind: 'withdraw', sessionId: 's1' },
    })
    // Seen again, nothing is left to withdraw.
    t.notifier.seen('s1')
    expect(t.sent).toHaveLength(2)
  })

  it('follows the switches for errors and routines', () => {
    const t = setup([device('phone', { errors: false }), device('pad', { routines: true })])
    const error: Attention = { ...ended('s1'), kind: 'error', title: 'T', body: 'Failed' }
    const routine: Attention = { ...ended('s2'), kind: 'routine-ended' }
    const paused: Attention = {
      kind: 'routine-paused',
      agentId: 'claude-code',
      title: 'Routines paused',
      body: 'Near the plan limit',
      inFront: false,
      devices: [],
    }
    for (const attention of [error, routine, paused]) t.notifier.attention(attention)
    t.settle()
    expect(alerts(t.sent).sort()).toEqual([
      ['pad', 'routines:claude-code'],
      ['pad', 's1'],
      ['pad', 's2'],
    ])
  })
})

describe('only while the user is away', () => {
  it('holds back while they are at the desktop app, and sends what still applies once they leave', () => {
    const t = setup([device('phone'), device('pad', { onlyAway: false })])
    t.notifier.setPresent(true)
    t.notifier.setWaiting({ s1: ['r1'], s2: ['r2'] })
    t.notifier.attention(permission('s1', 'r1'))
    t.notifier.attention(permission('s2', 'r2'))
    t.notifier.attention(ended('s3'))
    t.notifier.attention(ended('s4'))
    t.settle()
    expect(alerts(t.sent).sort()).toEqual([
      ['pad', 's1'],
      ['pad', 's2'],
      ['pad', 's3'],
      ['pad', 's4'],
    ])
    // Answered and seen at the desktop meanwhile.
    t.notifier.setWaiting({ s2: ['r2'] })
    t.notifier.seen('s4')
    t.sent.length = 0
    t.notifier.setPresent(false)
    t.settle()
    expect(alerts(t.sent).sort()).toEqual([
      ['phone', 's2'],
      ['phone', 's3'],
    ])
  })

  it('does not apply where the host cannot tell, as the daemon', () => {
    const t = setup([device('phone')])
    t.notifier.attention(ended('s1'))
    t.settle()
    expect(alerts(t.sent)).toEqual([['phone', 's1']])
  })
})

describe('the Live Activity', () => {
  const tokens = { start: 'c3'.repeat(80) }

  it('starts with the first request that waits, follows the count and ends with the last', () => {
    const phone = device('phone', {}, tokens)
    const t = setup([phone])
    t.notifier.setWaiting({ s1: ['r1'] })
    t.notifier.attention(permission('s1', 'r1'))
    t.settle()
    const activity = () => t.sent.filter((job) => job.type === 'activity')
    expect(activity()).toEqual([
      {
        deviceId: 'phone',
        subject: 'activity',
        type: 'activity',
        action: 'start',
        count: 1,
        sessionId: 's1',
        title: 'Fix the login form',
      },
    ])
    // Its own token comes from the device, and the update waits for it.
    t.notifier.setWaiting({ s1: ['r1'], s2: ['r2'] })
    t.notifier.attention(permission('s2', 'r2', { title: 'Write docs' }))
    t.settle()
    expect(activity()).toHaveLength(1)
    phone.push.target!.activity = { ...tokens, update: 'd4'.repeat(80) }
    t.notifier.deviceChanged()
    t.settle()
    expect(activity().at(-1)).toMatchObject({ action: 'update', count: 2, sessionId: 's2' })
    t.notifier.setWaiting({})
    t.settle()
    expect(activity().at(-1)).toMatchObject({ action: 'end', count: 0, sessionId: null })
  })

  it('counts no muted session, and starts for no device without its token or the switch', () => {
    const t = setup([
      device('phone', { muted: ['s1'] }, tokens),
      device('pad', { permission: false }, tokens),
      device('mini'),
    ])
    t.notifier.setWaiting({ s1: ['r1'] })
    t.notifier.attention(permission('s1', 'r1'))
    t.settle()
    expect(t.sent.filter((job) => job.type === 'activity')).toEqual([])
  })
})
