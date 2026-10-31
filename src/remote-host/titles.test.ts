import { describe, expect, it } from 'vitest'
import { SessionTitles } from './titles'

const summary = (id: string, title: string | null) => ({ id, title, agentId: 'fake-agent' })

describe('SessionTitles', () => {
  it('keeps the titles a list, summaries and removals tell the device', () => {
    const titles = new SessionTitles()
    titles.request(4, 'sessions.list')
    titles.received({ type: 'response', id: 3, result: [summary('s9', 'Not a list')] })
    titles.received({
      type: 'response',
      id: 4,
      result: [summary('s1', 'Fix the login'), summary('s2', null), { id: 7, title: 'x' }],
    })
    expect(titles.get('s1')).toBe('Fix the login')
    expect(titles.get('s2')).toBeNull()
    expect(titles.get('s9')).toBeUndefined()

    titles.received({
      type: 'event',
      event: { type: 'session.summary', summary: summary('s2', 'New') },
    })
    titles.received({ type: 'event', event: { type: 'session.removed', sessionId: 's1' } })
    expect(titles.get('s2')).toBe('New')
    expect(titles.get('s1')).toBeUndefined()
    // An answer read once is not read again.
    titles.received({ type: 'response', id: 4, result: [summary('s3', 'Late')] })
    expect(titles.get('s3')).toBeUndefined()
  })
})
