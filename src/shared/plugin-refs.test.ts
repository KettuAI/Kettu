import { describe, expect, it } from 'vitest'
import {
  matchLink,
  matchLinkPattern,
  mentionWord,
  parseLinkPattern,
  patternHostAllowed,
} from './plugin-refs'

const match = (pattern: string, url: string) => {
  const parsed = parseLinkPattern(pattern)
  if (!parsed) throw new Error(`not a pattern: ${pattern}`)
  return matchLinkPattern(parsed, url)
}

describe('link patterns', () => {
  it('reads a host, literal segments, captures, any segment and a rest', () => {
    expect(parseLinkPattern('https://Tracker.Example.com/issues/{key}/*/**')).toEqual({
      host: 'tracker.example.com',
      segments: [
        { kind: 'literal', text: 'issues' },
        { kind: 'capture', name: 'key' },
        { kind: 'any' },
      ],
      rest: true,
    })
    expect(parseLinkPattern('https://tracker.example.com')).toMatchObject({ segments: [] })
    expect(parseLinkPattern('https://*.example.com/a')).toMatchObject({ host: '*.example.com' })
  })

  it.each([
    'http://tracker.example.com/a',
    'tracker.example.com/a',
    'https://tracker.example.com/a?x=1',
    'https://tracker.example.com/a#top',
    'https://tracker.example.com:8443/a',
    'https://me@tracker.example.com/a',
    'https://tracker.example.com/a b',
    'https://tracker.example.com/a\\b',
    'https://tracker.example.com/a//b',
    'https://tracker.example.com/./b',
    'https://tracker.example.com/../b',
    'https://tracker.example.com/**/b',
    'https://tracker.example.com/{a}/{a}',
    'https://tracker.example.com/{A b}',
    'https://tracker.example.com/{}',
    'https://*/a',
    'https://*.com/a',
    'https://**.example.com/a',
    `https://tracker.example.com/${'a'.repeat(200)}`,
    `https://tracker.example.com/${Array(13).fill('a').join('/')}`,
    `https://tracker.example.com/${'a'.repeat(101)}`,
  ])('refuses %s', (pattern) => {
    expect(parseLinkPattern(pattern)).toBeNull()
  })

  it('refuses more captures than a pattern may hold', () => {
    const many = Array.from({ length: 9 }, (_, i) => `{c${i}}`).join('/')
    expect(parseLinkPattern(`https://tracker.example.com/${many}`)).toBeNull()
  })
})

describe('matching an address', () => {
  it('gives what the captures matched, decoded', () => {
    expect(match('https://t.example.com/issues/{key}', 'https://t.example.com/issues/T-1')).toEqual(
      {
        key: 'T-1',
      },
    )
    expect(
      match('https://t.example.com/{org}/issues/{key}', 'https://t.example.com/a%20b/issues/T%2D1'),
    ).toEqual({ org: 'a b', key: 'T-1' })
    expect(match('https://t.example.com/a', 'https://t.example.com/a')).toEqual({})
  })

  it('counts neither the query, the fragment nor one trailing slash', () => {
    expect(
      match('https://t.example.com/issues/{key}', 'https://t.example.com/issues/T-1/?x=1#top'),
    ).toEqual({ key: 'T-1' })
  })

  it('takes the root for a host-only pattern', () => {
    expect(match('https://t.example.com', 'https://t.example.com/')).toEqual({})
    expect(match('https://t.example.com', 'https://t.example.com/a')).toBeNull()
  })

  it('needs the same number of segments unless the pattern ends in a rest', () => {
    expect(match('https://t.example.com/issues/{key}', 'https://t.example.com/issues')).toBeNull()
    expect(
      match('https://t.example.com/issues/{key}', 'https://t.example.com/issues/T-1/edit'),
    ).toBeNull()
    expect(
      match('https://t.example.com/issues/{key}/**', 'https://t.example.com/issues/T-1/edit/x'),
    ).toEqual({ key: 'T-1' })
    expect(
      match('https://t.example.com/issues/{key}/**', 'https://t.example.com/issues/T-1'),
    ).toEqual({ key: 'T-1' })
    expect(match('https://t.example.com/issues/*', 'https://t.example.com/issues/x')).toEqual({})
  })

  it('never takes another host, scheme, port or login', () => {
    const pattern = 'https://t.example.com/a'
    for (const url of [
      'https://u.example.com/a',
      'https://t.example.com.evil.net/a',
      'https://evil.net/t.example.com/a',
      'http://t.example.com/a',
      'https://t.example.com:8443/a',
      'https://me:pw@t.example.com/a',
      'not an address',
    ]) {
      expect(match(pattern, url), url).toBeNull()
    }
  })

  it('takes every subdomain, and not the bare domain, for a wildcard host', () => {
    const pattern = 'https://*.example.com/a'
    expect(match(pattern, 'https://x.example.com/a')).toEqual({})
    expect(match(pattern, 'https://x.y.example.com/a')).toEqual({})
    expect(match(pattern, 'https://example.com/a')).toBeNull()
    expect(match(pattern, 'https://notexample.com/a')).toBeNull()
  })

  it('cuts a capture to its limit', () => {
    const long = 'x'.repeat(400)
    const found = match('https://t.example.com/{k}', `https://t.example.com/${long}`)
    expect(found?.k).toHaveLength(200)
  })

  it('gives the first kind of link whose pattern names the address', () => {
    const links = [
      { id: 'pull', patterns: ['https://t.example.com/pulls/{n}'] },
      { id: 'issue', patterns: ['https://nope.example.com/x', 'https://t.example.com/issues/{n}'] },
    ]
    expect(matchLink(links, 'https://t.example.com/issues/7')).toEqual({
      link: links[1],
      match: { n: '7' },
    })
    expect(matchLink(links, 'https://t.example.com/other')).toBeNull()
  })
})

describe('the hosts a pattern may name', () => {
  const allowed = (pattern: string, permissions: string[]) =>
    patternHostAllowed(parseLinkPattern(pattern)!, permissions)

  it('needs a network permission that covers the host', () => {
    expect(allowed('https://t.example.com/a', ['network:t.example.com'])).toBe(true)
    expect(allowed('https://t.example.com/a', ['network:*.example.com'])).toBe(true)
    expect(allowed('https://t.example.com/a', ['network:u.example.com'])).toBe(false)
    expect(allowed('https://t.example.com/a', ['sessions.summary'])).toBe(false)
    expect(allowed('https://t.example.com/a', [])).toBe(false)
  })

  it('needs a wildcard permission, as wide as the pattern, for a wildcard host', () => {
    expect(allowed('https://*.example.com/a', ['network:*.example.com'])).toBe(true)
    expect(allowed('https://*.example.com/a', ['network:t.example.com'])).toBe(false)
    expect(allowed('https://*.example.com/a', ['network:*.sub.example.com'])).toBe(false)
  })
})

describe('the word an item is written as', () => {
  it('keeps the word the plugin gave when it can be written after an @', () => {
    expect(mentionWord({ id: 'x', title: 'X', word: 'T-1' })).toBe('T-1')
    expect(mentionWord({ id: 'x', title: 'X', word: 'org/repo#12' })).toBe('org/repo#12')
  })

  it('falls back to the id, then to the title, when the word is not usable', () => {
    expect(mentionWord({ id: 'T-9', title: 'X', word: 'has space' })).toBe('T-9')
    expect(mentionWord({ id: 'a:b', title: 'Sync drops', word: 'T:1' })).toBe('Sync-drops')
    expect(mentionWord({ id: 'a b', title: 'Sync drops!' })).toBe('Sync-drops')
    expect(mentionWord({ id: 'T-1.', title: 'X' })).toBe('X')
  })

  it('never ends in punctuation, never holds a colon and always gives something', () => {
    expect(mentionWord({ id: '!!', title: '??' })).toBe('item')
    expect(mentionWord({ id: 'a', title: 'x', word: 'ends.' })).toBe('a')
    expect(mentionWord({ id: 'a:1', title: '问题 一' })).toBe('问题-一')
  })

  it('cuts a made word to the limit', () => {
    const word = mentionWord({ id: 'a b', title: 'y'.repeat(100) })
    expect(word).toHaveLength(40)
  })
})
