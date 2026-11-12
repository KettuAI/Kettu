import { describe, expect, it } from 'vitest'
import type { Caller } from './artifacts/tools'
import { DETAILS_CHARS, parseDraft, REPORT_TOOL, ReportTools, TITLE_CHARS } from './report-tool'

const caller = { sessionId: 's1', project: '/p', subagent: false } as unknown as Caller

describe('parseDraft', () => {
  it('takes a title, details and an optional error, trimmed', () => {
    expect(parseDraft({ title: '  Tool\n fails ', details: ' It fails. ' })).toEqual({
      title: 'Tool fails',
      details: 'It fails.',
      error: null,
    })
    expect(parseDraft({ title: 'T', details: 'D', error: 'E' }).error).toBe('E')
    expect(parseDraft({ title: 'T', details: 'D', error: '  ' }).error).toBeNull()
  })

  it('refuses missing, empty, oversized and unknown fields', () => {
    expect(() => parseDraft(null)).toThrow()
    expect(() => parseDraft({ details: 'D' })).toThrow()
    expect(() => parseDraft({ title: ' ', details: 'D' })).toThrow()
    expect(() => parseDraft({ title: 'T', details: 7 })).toThrow()
    expect(() => parseDraft({ title: 'x'.repeat(TITLE_CHARS + 1), details: 'D' })).toThrow()
    expect(() => parseDraft({ title: 'T', details: 'x'.repeat(DETAILS_CHARS + 1) })).toThrow()
    expect(() => parseDraft({ title: 'T', details: 'D', sessionId: 'other' })).toThrow()
  })
})

describe('ReportTools', () => {
  it("adds the draft to the caller's own session", () => {
    const added: string[] = []
    const tools = new ReportTools({
      add: (sessionId) => {
        added.push(sessionId)
        return 'added'
      },
    })
    const result = tools.call(caller, REPORT_TOOL, { title: 'T', details: 'D' })
    expect(result.isError).toBeUndefined()
    expect(added).toEqual(['s1'])
  })

  it('returns the limits and bad input as tool errors', () => {
    for (const refusal of ['open', 'daily', 'none'] as const) {
      const tools = new ReportTools({ add: () => refusal })
      expect(tools.call(caller, REPORT_TOOL, { title: 'T', details: 'D' }).isError).toBe(true)
    }
    const tools = new ReportTools({ add: () => 'added' })
    expect(tools.call(caller, REPORT_TOOL, { title: '' }).isError).toBe(true)
  })
})
