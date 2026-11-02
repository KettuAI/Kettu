import { describe, expect, it } from 'vitest'
import { MAX_LINK_SITES } from '@shared/settings'
import {
  asksBeforeOpening,
  bareParts,
  defaultDestination,
  hasUserinfo,
  isBareLink,
  isLocalLink,
  linkHost,
  linkSite,
  markdownLink,
  planLinkOpen,
  rememberSite,
  type LinkPrefs,
} from './link-open'

const prefs = (changes: Partial<LinkPrefs> = {}): LinkPrefs => ({
  openLinksIn: 'browser',
  confirmLinks: false,
  alwaysOpenIn: {},
  ...changes,
})
const inSession = { session: true }
const noSession = { session: false }

describe('hasUserinfo', () => {
  it.each(['https://user@example.com/', 'https://user:secret@example.com/'])(
    'finds a user name or password in %s',
    (url) => expect(hasUserinfo(url)).toBe(true),
  )

  it('finds none in a plain address', () => {
    expect(hasUserinfo('https://example.com/a@b')).toBe(false)
  })
})

describe('isLocalLink', () => {
  it.each([
    'http://localhost:5173/usage',
    'http://app.localhost/',
    'http://127.0.0.1:3000/',
    'http://127.1/',
    'http://[::1]:8080/',
  ])('takes %s as this computer', (url) => expect(isLocalLink(url)).toBe(true))

  it.each([
    'https://localhost.example.com/',
    'http://192.168.1.2/',
    'http://site.test/',
    'file:///etc/hosts',
    'not a url',
  ])('takes %s as elsewhere', (url) => expect(isLocalLink(url)).toBe(false))
})

describe('linkHost and linkSite', () => {
  it('splits the host where its registrable domain starts', () => {
    expect(linkHost('https://docs.kettu.sh/remote/pairing')).toEqual({
      prefix: 'docs.',
      domain: 'kettu.sh',
      port: '',
    })
    expect(linkHost('https://a.b.example.co.uk:8443/')).toEqual({
      prefix: 'a.b.',
      domain: 'example.co.uk',
      port: ':8443',
    })
    expect(linkSite('https://docs.kettu.sh/remote')).toBe('kettu.sh')
  })

  it('takes the whole host where it is the registrable domain, as on vercel.app', () => {
    const url = 'https://kettu-preview-git-fix-usage-day-key.vercel.app/usage'
    expect(linkHost(url)).toEqual({
      prefix: '',
      domain: 'kettu-preview-git-fix-usage-day-key.vercel.app',
      port: '',
    })
    expect(linkSite(url)).toBe('kettu-preview-git-fix-usage-day-key.vercel.app')
    expect(linkSite('https://kettu.sh/')).toBe('kettu.sh')
  })

  it('takes the whole host for an address or a name without a public suffix', () => {
    expect(linkHost('http://192.168.1.2:8080/')).toEqual({
      prefix: '',
      domain: '192.168.1.2',
      port: ':8080',
    })
    expect(linkSite('http://intranet/')).toBe('intranet')
    expect(linkSite('http://[::1]/')).toBe('[::1]')
  })

  it('reads the host as the URL parser does, past text before "@"', () => {
    expect(linkHost('https://github.com@evil.example.com/')?.domain).toBe('example.com')
  })

  it('has no site for a host that cannot be remembered, or an address that is not a web one', () => {
    expect(linkSite('http://__proto__/')).toBeNull()
    expect(linkSite('mailto:a@b.c')).toBeNull()
  })
})

describe('defaultDestination', () => {
  const url = 'https://docs.kettu.sh/remote'

  it("opens in the setting's place, the default browser for Ask", () => {
    expect(defaultDestination(url, prefs(), inSession)).toBe('browser')
    expect(defaultDestination(url, prefs({ openLinksIn: 'session' }), inSession)).toBe('session')
    expect(defaultDestination(url, prefs({ openLinksIn: 'ask' }), inSession)).toBe('browser')
  })

  it('opens a remembered site where it was sent', () => {
    const remembered = prefs({ openLinksIn: 'browser', alwaysOpenIn: { 'kettu.sh': 'session' } })
    expect(defaultDestination(url, remembered, inSession)).toBe('session')
  })

  it('does not take a remembered site from the object prototype', () => {
    expect(defaultDestination('http://constructor/', prefs(), inSession)).toBe('browser')
  })

  it('opens a local address in the session browser', () => {
    expect(defaultDestination('http://localhost:5173/', prefs(), inSession)).toBe('session')
  })

  it('opens everything in the default browser outside a session', () => {
    const session = prefs({ openLinksIn: 'session', alwaysOpenIn: { 'kettu.sh': 'session' } })
    expect(defaultDestination(url, session, noSession)).toBe('browser')
    expect(defaultDestination('http://localhost:5173/', session, noSession)).toBe('browser')
  })
})

describe('asksBeforeOpening', () => {
  const url = 'https://example.com/'

  it('asks while "Ask before opening a site for the first time" is on', () => {
    expect(asksBeforeOpening(url, prefs({ confirmLinks: true }), inSession)).toBe(true)
  })

  it('does not ask with it off', () => {
    expect(asksBeforeOpening(url, prefs(), inSession)).toBe(false)
  })

  it('asks while the setting is Ask, which needs a second place to offer', () => {
    expect(asksBeforeOpening(url, prefs({ openLinksIn: 'ask' }), inSession)).toBe(true)
    expect(asksBeforeOpening(url, prefs({ openLinksIn: 'ask' }), noSession)).toBe(false)
  })

  it('does not ask for a remembered site', () => {
    const remembered = prefs({
      confirmLinks: true,
      openLinksIn: 'ask',
      alwaysOpenIn: { 'example.com': 'browser' },
    })
    expect(asksBeforeOpening('https://www.example.com/a', remembered, inSession)).toBe(false)
  })

  it('does not ask for a local address in a session', () => {
    const asking = prefs({ confirmLinks: true, openLinksIn: 'ask' })
    expect(asksBeforeOpening('http://localhost:5173/', asking, inSession)).toBe(false)
    expect(asksBeforeOpening('http://localhost:5173/', asking, noSession)).toBe(true)
  })

  it.each([
    'https://user@example.com/',
    'https://user:secret@example.com/',
    'http://user@localhost:5173/',
  ])('always asks for %s', (url) => {
    const remembered = prefs({ alwaysOpenIn: { 'example.com': 'browser' } })
    expect(asksBeforeOpening(url, remembered, inSession)).toBe(true)
  })
})

describe('planLinkOpen', () => {
  const url = 'https://kettu.sh/'

  it('takes the other place on a Mod-click', () => {
    expect(planLinkOpen(url, prefs(), inSession, true)).toEqual({
      destination: 'session',
      ask: false,
    })
    expect(planLinkOpen(url, prefs({ openLinksIn: 'session' }), inSession, true)).toEqual({
      destination: 'browser',
      ask: false,
    })
    expect(planLinkOpen('http://localhost:3000/', prefs(), inSession, true).destination).toBe(
      'browser',
    )
  })

  it('never takes the session browser outside a session', () => {
    expect(planLinkOpen(url, prefs(), noSession, true).destination).toBe('browser')
  })

  it('still asks on a Mod-click when the site needs asking', () => {
    expect(planLinkOpen(url, prefs({ confirmLinks: true }), inSession, true)).toEqual({
      destination: 'session',
      ask: true,
    })
  })
})

describe('rememberSite', () => {
  it('adds or moves the site to the end', () => {
    expect(rememberSite({ 'a.com': 'browser', 'b.com': 'session' }, 'a.com', 'session')).toEqual({
      'b.com': 'session',
      'a.com': 'session',
    })
    expect(Object.keys(rememberSite({ 'a.com': 'browser' }, 'c.com', 'browser'))).toEqual([
      'a.com',
      'c.com',
    ])
  })

  it('drops the oldest sites beyond the limit', () => {
    const full = Object.fromEntries(
      Array.from({ length: MAX_LINK_SITES }, (_, i) => [`s${i}.com`, 'browser' as const]),
    )
    const next = rememberSite(full, 'new.com', 'session')
    expect(Object.keys(next)).toHaveLength(MAX_LINK_SITES)
    expect(next['s0.com']).toBeUndefined()
    expect(next['new.com']).toBe('session')
  })
})

describe('isBareLink and bareParts', () => {
  it.each([
    ['https://github.com/KettuAI/Kettu/pull/482', 'https://github.com/KettuAI/Kettu/pull/482'],
    ['github.com/KettuAI/Kettu', 'https://github.com/KettuAI/Kettu'],
    ['www.example.com', 'http://www.example.com'],
    ['https://example.com', 'https://example.com/'],
  ])('takes %j for %s as the address itself', (text, url) => {
    expect(isBareLink(text, url)).toBe(true)
  })

  it('takes other text as a label', () => {
    expect(isBareLink('date-fns 的 format 文档', 'https://date-fns.org/docs/format')).toBe(false)
    expect(isBareLink('example.com', 'https://example.com/about')).toBe(false)
  })

  it('shows the host, then the rest without a lone "/"', () => {
    expect(bareParts('https://github.com/KettuAI/Kettu/pull/482')).toEqual({
      host: 'github.com',
      rest: '/KettuAI/Kettu/pull/482',
    })
    expect(bareParts('http://localhost:5173/usage?d=1#top')).toEqual({
      host: 'localhost:5173',
      rest: '/usage?d=1#top',
    })
    expect(bareParts('https://kettu.sh/')).toEqual({ host: 'kettu.sh', rest: '' })
    expect(bareParts('https://zh.wikipedia.org/wiki/%E7%8B%90')).toEqual({
      host: 'zh.wikipedia.org',
      rest: '/wiki/狐',
    })
  })
})

describe('markdownLink', () => {
  it('writes a labelled link, escaping brackets in its text', () => {
    expect(markdownLink('date-fns [format] docs', 'https://date-fns.org/docs/format')).toBe(
      '[date-fns \\[format\\] docs](https://date-fns.org/docs/format)',
    )
  })

  it('escapes parentheses and spaces in the address', () => {
    expect(markdownLink('Fox', 'https://en.wikipedia.org/wiki/Fox_(disambiguation)')).toBe(
      '[Fox](https://en.wikipedia.org/wiki/Fox_%28disambiguation%29)',
    )
  })

  it('writes a bare address as an autolink', () => {
    expect(markdownLink('https://kettu.sh/', 'https://kettu.sh/')).toBe('<https://kettu.sh/>')
  })
})
