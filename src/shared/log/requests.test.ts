import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeLog } from './process-log'
import { isReadMethod, logRequest, REQUEST_REPEAT_MS, summarizeParams } from './requests'

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
