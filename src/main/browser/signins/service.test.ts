import type { Cookie, CookiesGetFilter, CookiesSetDetails } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { parseBrought, type BroughtStore } from './brought'
import type { ReadResult } from './reader'
import { SignIns, type SignInsDeps } from './service'
import { bringable, defaultPicks, signInSites, type BroughtCookie, type CookieMeta } from './sites'
import { signInChoice, signInRequest, signInSite } from './validate'
import { cookieDetails, removeSiteCookies, writeCookies, type CookieJar } from './write'

const NOW = Date.UTC(2026, 10, 14, 12)
const NOW_S = NOW / 1000
const DAY = 24 * 60 * 60 * 1000

function cookie(host: string, extra: Partial<BroughtCookie> = {}): BroughtCookie {
  return {
    host,
    name: 'sid',
    value: `value-of-${host}`,
    path: '/',
    secure: true,
    httpOnly: true,
    expires: NOW_S + 3600,
    sameSite: 'lax',
    lastUsed: NOW,
    ...extra,
  }
}

/** Electron's cookie store, as far as these calls go. */
class FakeJar implements CookieJar {
  cookies: Cookie[] = []
  flushed = 0

  async set(details: CookiesSetDetails): Promise<void> {
    const host = new URL(details.url).hostname
    this.cookies.push({
      name: details.name!,
      value: details.value!,
      domain: details.domain ?? host,
      hostOnly: !details.domain,
      path: details.path,
      secure: details.secure,
      httpOnly: details.httpOnly,
      session: details.expirationDate === undefined,
      ...(details.expirationDate !== undefined ? { expirationDate: details.expirationDate } : {}),
      sameSite: details.sameSite ?? 'unspecified',
    })
  }

  // As Electron 44 does: a domain filter gives the cookies a request to that host would carry,
  // never its subdomains' ones.
  async get(filter: CookiesGetFilter): Promise<Cookie[]> {
    if (filter.domain === undefined) return [...this.cookies]
    const host = filter.domain.replace(/^\./, '')
    return this.cookies.filter((c) => {
      const domain = c.domain!.replace(/^\./, '')
      return c.hostOnly ? domain === host : host === domain || host.endsWith(`.${domain}`)
    })
  }

  async remove(url: string, name: string): Promise<void> {
    const host = new URL(url).hostname
    this.cookies = this.cookies.filter(
      (c) => !(c.name === name && c.domain!.replace(/^\./, '') === host),
    )
  }

  async flushStore(): Promise<void> {
    this.flushed++
  }
}

class FakeStore {
  sites = parseBrought({})
  list = () => [...this.sites]
  add = (sites: typeof this.sites) => {
    this.sites = [...sites, ...this.sites.filter((s) => !sites.some((n) => n.site === s.site))]
  }
  remove = (site: string) => {
    this.sites = this.sites.filter((s) => s.site !== site)
  }
  clear = () => {
    this.sites = []
  }
  flush = async () => {}
}

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

function service(answers: Partial<Record<string, unknown>>, jar = new FakeJar()) {
  const store = new FakeStore()
  const run = vi.fn(async (request: { op: string }) => {
    if (!(request.op in answers)) throw new Error(`no answer for ${request.op}`)
    return answers[request.op]
  })
  const deps: SignInsDeps = {
    run: run as SignInsDeps['run'],
    cancel: vi.fn(),
    jar,
    store: store as unknown as BroughtStore,
    icon: async () => null,
    changed: vi.fn(),
    log: log as unknown as SignInsDeps['log'],
    now: () => NOW,
  }
  return { signIns: new SignIns(deps), deps, jar, store, run }
}

describe('signInSites and defaultPicks', () => {
  const meta = (host: string, extra: Partial<CookieMeta> = {}): CookieMeta => ({
    ...cookie(host),
    ...extra,
  })

  it('counts a site only for a valid cookie pages cannot read', () => {
    const sites = signInSites(
      [
        meta('notion.so', { httpOnly: false }),
        meta('expired.example', { expires: NOW_S - 1 }),
        meta('session.example', { expires: null }),
        meta('localhost'),
        meta('127.0.0.1'),
      ],
      NOW,
    )
    expect(sites.map((site) => site.site)).toEqual(['session.example'])
  })

  it('picks recent sites and leaves out email, banking, sign-on, Google, old and ad sites', () => {
    const sites = signInSites(
      [
        meta('github.com'),
        meta('.vercel.com', { lastUsed: NOW - 29 * DAY }),
        meta('old.example', { lastUsed: NOW - 31 * DAY }),
        meta('mail.proton.me'),
        meta('secure.chase.com'),
        meta('www.mybank.example'),
        meta('acme.okta.com'),
        meta('accounts.google.com'),
        meta('www.google.co.uk'),
        meta('www.youtube.com'),
        meta('.doubleclick.example', { sameSite: 'no_restriction' }),
      ],
      NOW,
    )
    expect(defaultPicks(sites).sort()).toEqual(['github.com', 'vercel.com'])
    const groups = Object.fromEntries(
      sites.map((site) => [site.site, `${site.group}:${site.kind}`]),
    )
    expect(groups).toMatchObject({
      'old.example': 'other:null',
      'proton.me': 'held:email',
      'chase.com': 'held:banking',
      'mybank.example': 'held:banking',
      'okta.com': 'held:sso',
      'google.com': 'google:null',
      'google.co.uk': 'google:null',
      'youtube.com': 'google:null',
      'doubleclick.example': 'other:null',
    })
  })

  it('never lets Google or a non-site through', () => {
    expect([
      ...bringable(['github.com', 'google.com', 'GitHub.com', 'a/b', 'mail.google.com']),
    ]).toEqual(['github.com'])
  })
})

describe('cookieDetails', () => {
  it('keeps a domain cookie a domain cookie and a host-only one host-only', () => {
    expect(cookieDetails(cookie('.github.com', { name: 'logged_in' }), NOW_S)).toEqual({
      url: 'https://github.com/',
      name: 'logged_in',
      value: 'value-of-.github.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      domain: '.github.com',
      expirationDate: NOW_S + 3600,
    })
    const hostOnly = cookieDetails(cookie('github.com', { name: '__Host-sid', path: '/' }), NOW_S)
    expect(hostOnly).not.toHaveProperty('domain')
    expect(hostOnly?.url).toBe('https://github.com/')
  })

  it('keeps a session cookie without an expiry, and an insecure one on http', () => {
    const details = cookieDetails(
      cookie('app.test.localhost', { expires: null, secure: false, path: '/app' }),
      NOW_S,
    )
    expect(details).toMatchObject({ url: 'http://app.test.localhost/app', secure: false })
    expect(details).not.toHaveProperty('expirationDate')
  })

  it('does not send an insecure cookie across sites, and drops expired ones', () => {
    expect(
      cookieDetails(cookie('a.example', { secure: false, sameSite: 'no_restriction' }), NOW_S)
        ?.sameSite,
    ).toBe('unspecified')
    expect(cookieDetails(cookie('a.example', { expires: NOW_S - 1 }), NOW_S)).toBeNull()
    expect(cookieDetails(cookie('bad host.example'), NOW_S)).toBeNull()
  })
})

describe('writeCookies', () => {
  it('writes only cookies of the chosen sites, whatever it is handed', async () => {
    const jar = new FakeJar()
    const written = await writeCookies(
      jar,
      [
        cookie('github.com'),
        cookie('.github.com', { name: 'logged_in' }),
        cookie('evil.example'),
        cookie('.google.com'),
        cookie('github.com.evil.example'),
      ],
      new Set(['github.com', 'google.com']),
      NOW_S,
    )
    expect(written).toEqual({ sites: ['github.com'], written: 2, failed: 0 })
    expect(jar.cookies.map((c) => c.domain)).toEqual(['github.com', '.github.com'])
    expect(jar.flushed).toBe(1)
  })
})

describe('removeSiteCookies', () => {
  it("removes the site's cookies and its subdomains', and no other site's", async () => {
    const jar = new FakeJar()
    await writeCookies(
      jar,
      [cookie('github.com'), cookie('gist.github.com'), cookie('notgithub.com')],
      new Set(['github.com', 'notgithub.com']),
      NOW_S,
    )
    expect(await removeSiteCookies(jar, 'github.com')).toBe(2)
    expect(jar.cookies.map((c) => c.domain)).toEqual(['notgithub.com'])
  })

  it("removes a subdomain's own cookies, which a domain filter leaves out", async () => {
    const jar = new FakeJar()
    await writeCookies(
      jar,
      [cookie('app.notion.so'), cookie('.www.notion.so'), cookie('.notion.so')],
      new Set(['notion.so']),
      NOW_S,
    )
    expect(await removeSiteCookies(jar, 'notion.so')).toBe(3)
    expect(jar.cookies).toEqual([])
  })
})

describe('SignIns', () => {
  it('writes the chosen sites and records them with the profile they came from', async () => {
    const read: ReadResult = { ok: true, cookies: [cookie('github.com'), cookie('vercel.com')] }
    const { signIns, jar, store, deps, run } = service({
      sources: [
        {
          browser: 'chrome',
          name: 'Google Chrome',
          app: null,
          unavailable: null,
          keychain: true,
          profiles: [{ id: 'Default', name: 'Personal', email: null, sites: 2 }],
        },
      ],
      read,
    })
    await signIns.sources()
    const result = await signIns.bring({
      browser: 'chrome',
      profile: 'Default',
      sites: ['github.com', 'google.com'],
    })
    expect(run).toHaveBeenLastCalledWith({
      op: 'read',
      request: { browser: 'chrome', profile: 'Default', sites: ['github.com'] },
    })
    expect(result).toEqual({ ok: true, sites: ['github.com'] })
    expect(jar.cookies.map((c) => c.domain)).toEqual(['github.com'])
    expect(store.sites).toEqual([
      { site: 'github.com', browser: 'chrome', profile: 'Personal', at: NOW },
    ])
    expect(deps.changed).toHaveBeenCalled()
    // Nothing the log was given holds a cookie's value.
    expect(JSON.stringify(log.info.mock.calls)).not.toContain('value-of')
  })

  it('brings nothing and records nothing when macOS was told Deny', async () => {
    const { signIns, jar, store } = service({ read: { ok: false, reason: 'denied' } })
    expect(
      await signIns.bring({ browser: 'chrome', profile: 'Default', sites: ['github.com'] }),
    ).toEqual({ ok: false, reason: 'denied' })
    expect(jar.cookies).toEqual([])
    expect(store.sites).toEqual([])
  })

  it('keeps listing a site whose sign-in lives on a subdomain', async () => {
    const { signIns } = service({ read: { ok: true, cookies: [cookie('app.notion.so')] } })
    await signIns.bring({ browser: 'chrome', profile: 'Default', sites: ['notion.so'] })
    expect((await signIns.brought()).map((site) => site.site)).toEqual(['notion.so'])
  })

  it('removes a brought site from the browser and the record', async () => {
    const { signIns, jar, store } = service({ read: { ok: true, cookies: [cookie('github.com')] } })
    await signIns.bring({ browser: 'chrome', profile: 'Default', sites: ['github.com'] })
    expect(await signIns.brought()).toHaveLength(1)
    await signIns.remove('github.com')
    expect(jar.cookies).toEqual([])
    expect(store.sites).toEqual([])
  })

  it('forgets a brought site the browser no longer has cookies for', async () => {
    const { signIns, jar, store } = service({ read: { ok: true, cookies: [cookie('github.com')] } })
    await signIns.bring({ browser: 'chrome', profile: 'Default', sites: ['github.com'] })
    jar.cookies = []
    expect(await signIns.brought()).toEqual([])
    expect(store.sites).toEqual([])
  })

  it("offers the most recently used profile's sign-in, never Google's or one Kettu has", async () => {
    const entry = (profile: string, lastUsed: number, site = 'github.com') => ({
      site,
      browser: 'chrome',
      browserName: 'Google Chrome',
      profile,
      profileName: profile,
      lastUsed,
      keychain: true,
    })
    const jar = new FakeJar()
    const { signIns, run } = service(
      {
        index: [entry('Default', NOW - DAY), entry('Work', NOW), entry('Work', NOW, 'google.com')],
      },
      jar,
    )
    expect(await signIns.offer('https://github.com/org/repo')).toMatchObject({
      site: 'github.com',
      profile: 'Work',
    })
    expect(await signIns.offer('https://accounts.google.com/')).toBeNull()
    expect(await signIns.offer('file:///etc/passwd')).toBeNull()
    await jar.set({ url: 'https://github.com/', name: 'sid', value: 'x', httpOnly: true })
    expect(await signIns.offer('https://github.com/')).toBeNull()
    // The sites are read once and kept for a while.
    expect(run.mock.calls.filter(([request]) => request.op === 'index')).toHaveLength(1)
  })
})

describe('validation', () => {
  it('takes a known browser, a profile string and site names only', () => {
    expect(signInRequest({ browser: 'chrome', profile: 'Default', sites: ['github.com'] })).toEqual(
      {
        browser: 'chrome',
        profile: 'Default',
        sites: ['github.com'],
      },
    )
    expect(() => signInChoice({ browser: 'opera', profile: 'Default' })).toThrow()
    expect(() => signInChoice({ browser: 'chrome', profile: '' })).toThrow()
    expect(() => signInChoice({ browser: 'chrome', profile: 'a\0b' })).toThrow()
    expect(() => signInRequest({ browser: 'chrome', profile: 'Default', sites: [] })).toThrow()
    for (const site of [
      'gist.github.com',
      'GitHub.com',
      'github.com/',
      '127.0.0.1',
      'localhost',
      3,
    ]) {
      expect(() => signInSite(site)).toThrow()
    }
  })

  it('keeps a stored record leniently, newest first', () => {
    expect(
      parseBrought({
        sites: [
          { site: 'github.com', browser: 'chrome', profile: 'Personal', at: 1 },
          { site: 'github.com', browser: 'arc', profile: 'Work', at: 2 },
          { site: 'vercel.com', browser: 'opera', profile: 'x', at: 3 },
          { site: 'Bad Site', browser: 'chrome', profile: 'x', at: 3 },
          null,
        ],
      }),
    ).toEqual([{ site: 'github.com', browser: 'arc', profile: 'Work', at: 2 }])
  })
})
