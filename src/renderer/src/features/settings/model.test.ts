import { describe, expect, it } from 'vitest'
import { excerpt, highlight, matches, type RowDef } from './model'

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

  it('matches only at the start of a word', () => {
    expect(matches(row, 'win')).toBe(true)
    expect(matches(row, 'indow')).toBe(false)
    expect(matches(row, 'heme')).toBe(false)
    const shell = { ...row, name: 'Shell', description: 'Turn finished.', keywords: undefined }
    expect(matches(shell, 'sh')).toBe(true)
    expect(matches({ ...shell, name: 'Font' }, 'sh')).toBe(false)
  })

  it('counts what follows punctuation as the start of a word', () => {
    const shell = { ...row, description: 'Your login shell ($SHELL).' }
    expect(matches(shell, 'shell')).toBe(true)
    expect(matches({ ...row, description: 'npm, npx and updates' }, 'npx')).toBe(true)
  })

  it('matches anywhere in Chinese, which has no spaces between words', () => {
    const proxy = { ...row, name: '网络代理', description: undefined, keywords: undefined }
    expect(matches(proxy, '代理')).toBe(true)
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

  it('marks every place each word starts a word, ignoring case', () => {
    expect(marked('Check for updates', 'UP')).toBe('Check for [up]dates')
    expect(marked('Proxy for npm and updates', 'pro up')).toBe('[Pro]xy for npm and [up]dates')
    expect(marked('Show what the sidebar shows', 'sh')).toBe('[Sh]ow what the sidebar [sh]ows')
  })

  it('leaves a match inside a word unmarked', () => {
    expect(marked('Turn finished', 'sh')).toBe('Turn finished')
  })

  it('joins overlapping matches into one mark', () => {
    expect(marked('Theme', 'the them')).toBe('[Them]e')
  })

  it('leaves the text whole without a query', () => {
    expect(highlight('Theme', '  ')).toEqual([{ text: 'Theme', match: false }])
  })
})

describe('excerpt', () => {
  const long =
    'A file with recent agent messages, logs and paths, for a bug report. It can contain code and prompts, so share it only with people you trust.'

  it('keeps a text whose match is near its start', () => {
    expect(excerpt(long, 'recent')).toBe(long)
    expect(excerpt('Short', 'zzz')).toBe('Short')
  })

  it('starts a deep match shortly before it, at a word', () => {
    const cut = excerpt(long, 'share')
    expect(cut.startsWith('…')).toBe(true)
    expect(cut.endsWith('share it only with people you trust.')).toBe(true)
    expect(cut.length).toBeLessThan(long.length)
    expect(cut[1]).not.toBe(' ')
    expect(long.includes(cut.slice(1))).toBe(true)
    expect(long[long.indexOf(cut.slice(1)) - 1]).toBe(' ')
  })
})
