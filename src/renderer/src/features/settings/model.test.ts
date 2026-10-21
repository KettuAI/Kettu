import { describe, expect, it } from 'vitest'
import { matches, type RowDef } from './model'

const row: RowDef = {
  id: 'theme',
  name: 'Theme',
  description: 'How the window looks.',
  keywords: 'dark light',
  render: () => null,
}

describe('matches', () => {
  it('matches everything without a query', () => {
    expect(matches(row, '')).toBe(true)
  })

  it('matches the name, the description and the keywords, ignoring case', () => {
    expect(matches(row, 'THEME')).toBe(true)
    expect(matches(row, 'window')).toBe(true)
    expect(matches(row, 'dark')).toBe(true)
  })

  it('needs every word to match', () => {
    expect(matches(row, 'dark theme')).toBe(true)
    expect(matches(row, 'dark proxy')).toBe(false)
  })
})
