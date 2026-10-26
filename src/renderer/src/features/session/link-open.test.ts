import { describe, expect, it } from 'vitest'
import { asksBeforeOpening } from './link-open'

describe('asksBeforeOpening', () => {
  it('asks while the setting is on', () => {
    expect(asksBeforeOpening('https://example.com/', true)).toBe(true)
  })

  it('does not ask with the setting off', () => {
    expect(asksBeforeOpening('https://example.com/', false)).toBe(false)
  })

  it.each(['https://user@example.com/', 'https://user:secret@example.com/'])(
    'still asks with the setting off for %s',
    (url) => {
      expect(asksBeforeOpening(url, false)).toBe(true)
    },
  )
})
