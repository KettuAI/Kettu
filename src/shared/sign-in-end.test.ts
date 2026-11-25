import { describe, expect, it } from 'vitest'
import { instantOf, signInEnd } from './sign-in-end'

const DAY = 24 * 60 * 60_000
const latest = Date.parse('2026-12-02T13:46:01.033Z')

describe('signInEnd', () => {
  it('puts the earliest end 3 days before the date', () => {
    expect(signInEnd(latest, latest - 20 * DAY).earliest).toBe(latest - 3 * DAY)
  })

  it('starts the reminders 6 days before the date', () => {
    expect(signInEnd(latest, latest - 6 * DAY - 1).phase).toBe('later')
    expect(signInEnd(latest, latest - 6 * DAY).phase).toBe('soon')
    expect(signInEnd(latest, latest - 2 * DAY).phase).toBe('soon')
    expect(signInEnd(latest, latest - 1).phase).toBe('soon')
  })

  it('calls the sign-in probably ended once the date passed', () => {
    expect(signInEnd(latest, latest).phase).toBe('ended')
    expect(signInEnd(latest, latest + 30 * DAY).phase).toBe('ended')
  })
})

describe('instantOf', () => {
  it('reads an ISO 8601 instant', () => {
    expect(instantOf('2026-12-02T13:46:01.033Z')).toBe(latest)
  })

  it('ignores what is not one', () => {
    for (const value of [
      null,
      undefined,
      '',
      'soon',
      '2026-12-02',
      '2026-13-45T00:00:00Z',
      latest,
    ]) {
      expect(instantOf(value)).toBeNull()
    }
  })
})
