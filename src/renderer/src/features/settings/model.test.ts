import { describe, expect, it } from 'vitest'
import { highlight, matches, type RowDef } from './model'

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

  it('matches the English name in any language', () => {
    const translated = { ...row, name: '主题', description: undefined, english: 'Theme' }
    expect(matches(translated, '主题')).toBe(true)
    expect(matches(translated, 'theme')).toBe(true)
  })

  it('needs every word to match', () => {
    expect(matches(row, 'dark theme')).toBe(true)
    expect(matches(row, 'dark proxy')).toBe(false)
  })
})

describe('highlight', () => {
  const marked = (text: string, query: string) =>
    highlight(text, query)
      .map((p) => (p.match ? `[${p.text}]` : p.text))
      .join('')

  it('marks every place each word occurs, ignoring case', () => {
    expect(marked('Check for updates', 'UP')).toBe('Check for [up]dates')
    expect(marked('Proxy for npm and updates', 'pro up')).toBe('[Pro]xy for npm and [up]dates')
  })

  it('joins overlapping matches into one mark', () => {
    expect(marked('Theme', 'the hem')).toBe('[Them]e')
  })

  it('leaves the text whole without a query', () => {
    expect(highlight('Theme', '  ')).toEqual([{ text: 'Theme', match: false }])
  })
})
