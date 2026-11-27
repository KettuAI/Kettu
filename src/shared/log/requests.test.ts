import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeLog } from './process-log'
import {
  isReadMethod,
  LARGE_ANSWER_BYTES,
  logDeviceDelivery,
  logDeviceLiveUpdate,
  logDevicePush,
  logRequest,
  REQUEST_REPEAT_MS,
  SLOW_ANSWER_MS,
  summarizeParams,
} from './requests'

vi.mock('./process-log', () => ({ writeLog: vi.fn() }))

describe('summarizeParams', () => {
  it('keeps ids, choices, numbers and switches', () => {
    expect(
      summarizeParams({
        sessionId: 's-1',
        agentId: 'claude-code',
        mode: 'plan',
        limit: 50,
        pinned: true,
        cursor: null,
      }),
    ).toEqual({
      sessionId: 's-1',
      agentId: 'claude-code',
      mode: 'plan',
      limit: 50,
      pinned: true,
      cursor: null,
    })
  })

  it('reduces text, lists and objects to their size', () => {
    expect(
      summarizeParams({
        text: 'please fix the login bug',
        path: '/Users/ann/project/src/a.ts',
        content: [{ type: 'text', text: 'hi' }],
        options: { a: 1 },
      }),
    ).toEqual({ text: '<24 chars>', path: '<27 chars>', content: '<1 items>', options: '<object>' })
  })

  it('omits secret-like values but keeps their ids', () => {
    expect(summarizeParams({ apiKey: 'sk-abc', token: 'x', keyId: 'k-1' })).toEqual({
      apiKey: '<omitted>',
      token: '<omitted>',
      keyId: 'k-1',
    })
  })

  it('lists id arrays up to a limit', () => {
    const ids = Array.from({ length: 22 }, (_, i) => `s-${i}`)
    const summary = summarizeParams({ sessionIds: ids }) as { sessionIds: string[] }
    expect(summary.sessionIds).toHaveLength(21)
    expect(summary.sessionIds.at(-1)).toBe('<2 more>')
  })

  it('does not trust a long value under an id key', () => {
    expect(summarizeParams({ sessionId: 'x'.repeat(200) })).toEqual({ sessionId: '<200 chars>' })
  })
})

describe('isReadMethod', () => {
  it('tells reads and watches from actions', () => {
    expect(isReadMethod('sessions.list')).toBe(true)
    expect(isReadMethod('git.status')).toBe(true)
    expect(isReadMethod('sessions.prompt')).toBe(false)
    expect(isReadMethod('permissions.respond')).toBe(false)
  })
})

describe('logRequest', () => {
  const written = () => vi.mocked(writeLog).mock.calls
  const SUMMARY = { from: 1, to: 2, dayStarts: [1, 2], scope: 'computer' }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(writeLog).mockClear()
  })
  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  it("counts a client's repeats of the same request instead of writing each", () => {
    for (let i = 0; i < 25; i++) logRequest('usage.summary', SUMMARY, 'd-1')
    expect(written()).toHaveLength(1)
    vi.advanceTimersByTime(REQUEST_REPEAT_MS)
    expect(written()).toEqual([
      ['debug', 'request', 'usage.summary', { device: 'd-1', ...summarizeParams(SUMMARY) }],
      [
        'debug',
        'request',
        'usage.summary repeated 24 times',
        { device: 'd-1', ...summarizeParams(SUMMARY), repeated: 24 },
      ],
    ])
    // A repeat after the count was written is counted again.
    logRequest('usage.summary', SUMMARY, 'd-1')
    expect(written()).toHaveLength(2)
  })

  it('writes the count of the repeats before a different request from the same client', () => {
    for (let i = 0; i < 3; i++) logRequest('sessions.rename', { sessionId: 's', title: 'a' }, 'd-2')
    logRequest('sessions.pin', { sessionId: 's', pinned: true }, 'd-2')
    expect(written().map((call) => call[2])).toEqual([
      'sessions.rename',
      'sessions.rename repeated 2 times',
      'sessions.pin',
    ])
  })

  it('keeps clients apart', () => {
    logRequest('usage.summary', SUMMARY, 'd-3')
    logRequest('usage.summary', SUMMARY, 'd-4')
    logRequest('usage.summary', SUMMARY, null)
    expect(written()).toHaveLength(3)
  })
})

describe('设备送达耗时日志', () => {
  const written = () => vi.mocked(writeLog).mock.calls

  beforeEach(() => {
    vi.mocked(writeLog).mockClear()
  })

  it('按耗时、大小、队列积压与错误区分回答送达日志级别', () => {
    logDeviceDelivery('sessions.list', {
      device: 'd-1',
      ms: 40,
      hostMs: 25,
      queueMs: 5,
      writeMs: 10,
      queuedBytes: 512,
      bytes: 1024,
    })
    logDeviceDelivery('sessions.open', {
      device: 'd-1',
      ms: SLOW_ANSWER_MS,
      hostMs: 120,
      queueMs: 90,
      writeMs: 40,
      queuedBytes: 128_000,
      bytes: 4096,
    })
    logDeviceDelivery('sessions.prompt', {
      device: 'd-2',
      ms: 20,
      hostMs: 15,
      queueMs: 0,
      writeMs: 5,
      queuedBytes: 0,
      bytes: 128,
      error: 'busy',
    })

    expect(written()).toEqual([
      [
        'debug',
        'request',
        'sessions.list delivered',
        {
          device: 'd-1',
          ms: 40,
          hostMs: 25,
          queueMs: 5,
          writeMs: 10,
          queuedBytes: 512,
          bytes: 1024,
        },
      ],
      [
        'info',
        'request',
        'sessions.open delivered',
        {
          device: 'd-1',
          ms: SLOW_ANSWER_MS,
          hostMs: 120,
          queueMs: 90,
          writeMs: 40,
          queuedBytes: 128_000,
          bytes: 4096,
        },
      ],
      [
        'info',
        'request',
        'sessions.prompt delivered',
        {
          device: 'd-2',
          ms: 20,
          hostMs: 15,
          queueMs: 0,
          writeMs: 5,
          queuedBytes: 0,
          bytes: 128,
          error: 'busy',
        },
      ],
    ])
  })

  it('记录实时更新从刷出到写出的耗时及合并批次信息', () => {
    logDeviceLiveUpdate('session.patches', {
      device: 'd-1',
      ms: 12,
      queueMs: 4,
      writeMs: 8,
      queuedBytes: 0,
      bytes: 200,
      sessionId: 's-1',
    })
    logDeviceLiveUpdate('session.patches', {
      device: 'd-1',
      ms: 310,
      queueMs: 280,
      writeMs: 30,
      queuedBytes: LARGE_ANSWER_BYTES,
      bytes: 8000,
      merged: 4,
      sessionId: 's-1',
    })

    expect(written()).toEqual([
      [
        'debug',
        'request',
        'session.patches written',
        {
          device: 'd-1',
          ms: 12,
          queueMs: 4,
          writeMs: 8,
          queuedBytes: 0,
          bytes: 200,
          sessionId: 's-1',
        },
      ],
      [
        'info',
        'request',
        'session.patches written',
        {
          device: 'd-1',
          ms: 310,
          queueMs: 280,
          writeMs: 30,
          queuedBytes: LARGE_ANSWER_BYTES,
          bytes: 8000,
          merged: 4,
          sessionId: 's-1',
        },
      ],
    ])
  })

  it('以 info 级别记录推送从入队到网关接收耗时', () => {
    logDevicePush({
      device: 'd-9',
      kind: 'alert',
      ms: 640,
      gatewayMs: 180,
      attempts: 2,
    })

    expect(written()).toEqual([
      [
        'info',
        'request',
        'push accepted',
        {
          device: 'd-9',
          kind: 'alert',
          ms: 640,
          gatewayMs: 180,
          attempts: 2,
        },
      ],
    ])
  })
})
