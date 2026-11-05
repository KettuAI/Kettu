import { describe, expect, it } from 'vitest'
import { isReadMethod, summarizeParams } from './requests'

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
