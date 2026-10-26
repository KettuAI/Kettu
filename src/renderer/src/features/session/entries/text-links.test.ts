import { describe, expect, it } from 'vitest'
import { splitLinks } from './text-links'

const text = (value: string) => ({ type: 'text', text: value })
const link = (url: string) => ({ type: 'link', url })

describe('splitLinks', () => {
  it('finds an address mid-sentence', () => {
    expect(splitLinks('See https://example.com/docs for the details')).toEqual([
      text('See '),
      link('https://example.com/docs'),
      text(' for the details'),
    ])
  })

  it('leaves punctuation after an address outside it', () => {
    expect(splitLinks('Read https://example.com/a.')).toEqual([
      text('Read '),
      link('https://example.com/a'),
      text('.'),
    ])
    expect(splitLinks('At https://example.com/a, then')).toEqual([
      text('At '),
      link('https://example.com/a'),
      text(', then'),
    ])
    expect(splitLinks('(see https://example.com/a)')).toEqual([
      text('(see '),
      link('https://example.com/a'),
      text(')'),
    ])
    expect(splitLinks('Is it https://example.com/a?! Yes: "https://example.com/b".')).toEqual([
      text('Is it '),
      link('https://example.com/a'),
      text('?! Yes: "'),
      link('https://example.com/b'),
      text('".'),
    ])
  })

  it('stops at Chinese punctuation that follows without a space', () => {
    expect(splitLinks('详见 https://example.com/a。')).toEqual([
      text('详见 '),
      link('https://example.com/a'),
      text('。'),
    ])
    expect(splitLinks('打开 https://example.com/a，然后重试')).toEqual([
      text('打开 '),
      link('https://example.com/a'),
      text('，然后重试'),
    ])
  })

  it('keeps a closing parenthesis that the address opens', () => {
    expect(splitLinks('(see https://en.wikipedia.org/wiki/Fork_(software))')).toEqual([
      text('(see '),
      link('https://en.wikipedia.org/wiki/Fork_(software)'),
      text(')'),
    ])
  })

  it('keeps a port, a query and a fragment', () => {
    expect(splitLinks('http://localhost:5173/x?y=1#z')).toEqual([
      link('http://localhost:5173/x?y=1#z'),
    ])
    expect(splitLinks('HTTPS://Example.com/A')).toEqual([link('HTTPS://Example.com/A')])
  })

  it('links only http and https addresses', () => {
    for (const value of [
      'ftp://example.com/a',
      'mailto:team@example.com',
      'www.example.com',
      'https://',
      'See https:// and http://',
      'https://[::1',
      'xhttps://example.com/a',
    ]) {
      expect(splitLinks(value), value).toEqual([text(value)])
    }
  })

  it('finds two addresses in one line', () => {
    expect(splitLinks('https://a.example/1 or https://b.example/2')).toEqual([
      link('https://a.example/1'),
      text(' or '),
      link('https://b.example/2'),
    ])
  })

  it('gives text without an address back whole', () => {
    expect(splitLinks('Insufficient balance.\nTop up and try again.')).toEqual([
      text('Insufficient balance.\nTop up and try again.'),
    ])
    expect(splitLinks('')).toEqual([])
  })
})
