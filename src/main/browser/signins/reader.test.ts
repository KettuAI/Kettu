import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chromiumKey, chromiumProfiles, decryptChromiumValue } from './chromium'
import { encryptChromium, writeChromiumRoot, writeFirefoxDb, type FixtureCookie } from './fixtures'
import { firefoxProfiles } from './firefox'
import type { KeySource } from './keychain'
import { listSites, listSources, readCookies, siteIndex, type ReaderEnv } from './reader'

const NOW = Date.UTC(2026, 10, 14, 12)
const PASSWORD = 'test-safe-storage-password'

let home: string
let tmp: string

function env(platform: NodeJS.Platform): ReaderEnv {
  return {
    platform,
    home,
    localAppData: join(home, 'AppData', 'Local'),
    appData: join(home, 'AppData', 'Roaming'),
    configHome: null,
    programFiles: [],
    tmp,
  }
}

const keys = (password: string | null): KeySource =>
  vi.fn(async () =>
    password === null
      ? { ok: false as const, reason: 'denied' as const }
      : { ok: true as const, password },
  )

const never = new AbortController().signal

const chromeCookies: FixtureCookie[] = [
  { host: 'github.com', name: 'user_session', value: 'gh-session' },
  { host: '.github.com', name: 'logged_in', value: 'yes', httpOnly: false },
  { host: 'gist.github.com', name: 'gist', value: 'gist-session' },
  { host: 'app.tracklane.io', name: 'sid', value: 'tracklane', usedDaysAgo: 2 },
  { host: 'mail.proton.me', name: 'AUTH', value: 'proton', usedDaysAgo: 1 },
  { host: '.google.com', name: 'SID', value: 'google' },
  { host: 'old.example', name: 'sid', value: 'old', usedDaysAgo: 90 },
  { host: '.ads.example', name: 'id', value: 'ad', sameSite: 0 },
  { host: 'embedded.example', name: 'sid', value: 'partitioned', partitioned: true },
  { host: 'notion.so', name: 'pref', value: 'dark', httpOnly: false },
]

function chromeRoot(): string {
  return join(home, 'Library', 'Application Support', 'Google', 'Chrome')
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'kettu-signins-home-'))
  tmp = mkdtempSync(join(tmpdir(), 'kettu-signins-tmp-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(tmp, { recursive: true, force: true })
})

describe('decryptChromiumValue', () => {
  const key = chromiumKey(PASSWORD)

  it('opens a value and takes the host digest off from version 24', () => {
    const encrypted = encryptChromium('s3cret', 'github.com', PASSWORD, 24)
    expect(decryptChromiumValue(encrypted, '', 'github.com', key, 24)).toBe('s3cret')
  })

  it('opens an older value, which has no digest', () => {
    const encrypted = encryptChromium('s3cret', 'github.com', PASSWORD, 23)
    expect(decryptChromiumValue(encrypted, '', 'github.com', key, 23)).toBe('s3cret')
  })

  it('refuses a value under another key, of another host or of another platform', () => {
    const encrypted = encryptChromium('s3cret', 'github.com', 'another password', 24)
    expect(decryptChromiumValue(encrypted, '', 'github.com', key, 24)).toBeNull()
    const moved = encryptChromium('s3cret', 'github.com', PASSWORD, 24)
    expect(decryptChromiumValue(moved, '', 'evil.example', key, 24)).toBeNull()
    const linux = Buffer.concat([Buffer.from('v11'), moved.subarray(3)])
    expect(decryptChromiumValue(linux, '', 'github.com', key, 24)).toBeNull()
  })

  it('keeps a plain value the database stored unencrypted', () => {
    expect(decryptChromiumValue(new Uint8Array(), 'plain', 'github.com', key, 24)).toBe('plain')
  })
})

describe('chromiumProfiles', () => {
  it('lists folders with names and accounts, never a path', () => {
    const profiles = chromiumProfiles({
      profile: {
        info_cache: {
          Default: { name: 'Personal', user_name: 'me@example.com', active_time: 10 },
          'Profile 1': { name: 'Work', active_time: 20 },
          '../escape': { name: 'Bad' },
        },
      },
    })
    expect(profiles).toEqual([
      { id: 'Profile 1', name: 'Work', email: null },
      { id: 'Default', name: 'Personal', email: 'me@example.com' },
    ])
  })
})

describe('Chromium on macOS', () => {
  beforeEach(() => {
    writeChromiumRoot(
      chromeRoot(),
      [{ id: 'Default', name: 'Personal', email: 'me@example.com', cookies: chromeCookies }],
      PASSWORD,
      NOW,
    )
  })

  it('lists Chrome with its profile, its sites counted without a key', async () => {
    const sources = await listSources(env('darwin'), NOW)
    const chrome = sources.find((source) => source.browser === 'chrome')
    expect(chrome).toMatchObject({
      name: 'Google Chrome',
      unavailable: null,
      keychain: true,
    })
    // github.com, tracklane.io, proton.me, google.com, old.example and ads.example.
    expect(chrome?.profiles).toEqual([
      { id: 'Default', name: 'Personal', email: 'me@example.com', sites: 6 },
    ])
    expect(readdirSync(tmp)).toEqual([])
  })

  it('groups the sites: recent picked, email held, Google apart, old and ad sites with the rest', async () => {
    const sites = await listSites(env('darwin'), { browser: 'chrome', profile: 'Default' }, NOW)
    expect(Object.fromEntries(sites!.map((site) => [site.site, [site.group, site.kind]]))).toEqual({
      'github.com': ['recent', null],
      'tracklane.io': ['recent', null],
      'proton.me': ['held', 'email'],
      'google.com': ['google', null],
      'old.example': ['other', null],
      'ads.example': ['other', null],
    })
  })

  it('answers null for a profile the browser does not have', async () => {
    expect(
      await listSites(env('darwin'), { browser: 'chrome', profile: '../../Firefox' }, NOW),
    ).toBeNull()
    expect(await listSites(env('darwin'), { browser: 'edge', profile: 'Default' }, NOW)).toBeNull()
  })

  it('reads only the chosen sites, never Google, and decrypts them with the key', async () => {
    const source = keys(PASSWORD)
    const result = await readCookies(
      env('darwin'),
      { browser: 'chrome', profile: 'Default', sites: ['github.com', 'google.com'] },
      source,
      never,
    )
    expect(source).toHaveBeenCalledWith('Chrome Safe Storage', never)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(
      result.cookies.map((cookie) => [cookie.host, cookie.name, cookie.value, cookie.httpOnly]),
    ).toEqual([
      ['github.com', 'user_session', 'gh-session', true],
      ['.github.com', 'logged_in', 'yes', false],
      ['gist.github.com', 'gist', 'gist-session', true],
    ])
    expect(readdirSync(tmp)).toEqual([])
  })

  it('asks for no key when none of the chosen sites has a cookie', async () => {
    const source = keys(PASSWORD)
    const result = await readCookies(
      env('darwin'),
      { browser: 'chrome', profile: 'Default', sites: ['google.com', 'nothing.example'] },
      source,
      never,
    )
    expect(result).toEqual({ ok: true, cookies: [] })
    expect(source).not.toHaveBeenCalled()
  })

  it('brings nothing when macOS is told Deny or the key does not open the values', async () => {
    const request = { browser: 'chrome' as const, profile: 'Default', sites: ['github.com'] }
    expect(await readCookies(env('darwin'), request, keys(null), never)).toEqual({
      ok: false,
      reason: 'denied',
    })
    expect(await readCookies(env('darwin'), request, keys('wrong'), never)).toEqual({
      ok: false,
      reason: 'unreadable',
    })
  })

  it('indexes the sites for offers without Google', async () => {
    const index = await siteIndex(env('darwin'), NOW)
    expect(index.map((entry) => entry.site).sort()).toEqual([
      'ads.example',
      'github.com',
      'old.example',
      'proton.me',
      'tracklane.io',
    ])
    expect(index[0]).toMatchObject({
      browser: 'chrome',
      profile: 'Default',
      profileName: 'Personal',
    })
  })
})

describe('firefoxProfiles', () => {
  it('reads relative and absolute profiles, the install default first, and none outside', () => {
    const ini = [
      '[Profile1]',
      'Name=work',
      'IsRelative=1',
      'Path=Profiles/abc.work',
      '',
      '[Profile0]',
      'Name=default-release',
      'IsRelative=1',
      'Path=Profiles/xyz.default-release',
      '',
      '[Profile2]',
      'Name=elsewhere',
      'IsRelative=0',
      'Path=/data/firefox/profile',
      '',
      '[Profile3]',
      'Name=escape',
      'IsRelative=1',
      'Path=../../.ssh',
      '',
      '[Install4F96D1932A9F858E]',
      'Default=Profiles/xyz.default-release',
    ].join('\n')
    expect(firefoxProfiles(ini, '/home/me/.mozilla/firefox')).toEqual([
      {
        id: 'Profiles/xyz.default-release',
        name: 'default-release',
        dir: '/home/me/.mozilla/firefox/Profiles/xyz.default-release',
        default: true,
      },
      {
        id: 'Profiles/abc.work',
        name: 'work',
        dir: '/home/me/.mozilla/firefox/Profiles/abc.work',
        default: false,
      },
      {
        id: '/data/firefox/profile',
        name: 'elsewhere',
        dir: '/data/firefox/profile',
        default: false,
      },
    ])
  })
})

describe('Firefox', () => {
  const firefoxCookies: FixtureCookie[] = [
    { host: 'github.com', name: 'user_session', value: 'ff-session', sameSite: 1 },
    { host: '.github.com', name: 'logged_in', value: 'yes', httpOnly: false, sameSite: 0 },
    { host: 'vercel.com', name: 'token', value: 'vercel', originAttributes: '^userContextId=2' },
    { host: 'secure.chase.com', name: 'sid', value: 'bank' },
  ]

  function firefoxRoot(root: string, expiryInMs: boolean): void {
    const profile = join(root, 'Profiles', 'abc.default-release')
    mkdirSync(profile, { recursive: true })
    writeFileSync(
      join(root, 'profiles.ini'),
      '[Profile0]\nName=default-release\nIsRelative=1\nPath=Profiles/abc.default-release\nDefault=1\n',
    )
    writeFirefoxDb(join(profile, 'cookies.sqlite'), firefoxCookies, NOW, expiryInMs)
  }

  it('lists Firefox on Linux, with Chrome there unavailable', async () => {
    firefoxRoot(join(home, '.mozilla', 'firefox'), false)
    mkdirSync(join(home, '.config', 'google-chrome'), { recursive: true })
    const sources = await listSources(env('linux'), NOW)
    expect(sources.map((source) => [source.browser, source.unavailable, source.profiles])).toEqual([
      ['chrome', 'linux-keyring', []],
      [
        'firefox',
        null,
        [{ id: 'Profiles/abc.default-release', name: 'default-release', email: null, sites: 2 }],
      ],
    ])
  })

  it('reads plain values of the chosen sites without a key, leaving containers out', async () => {
    firefoxRoot(join(home, 'AppData', 'Roaming', 'Mozilla', 'Firefox'), true)
    const source = keys(PASSWORD)
    const result = await readCookies(
      env('win32'),
      {
        browser: 'firefox',
        profile: 'Profiles/abc.default-release',
        sites: ['github.com', 'vercel.com'],
      },
      source,
      never,
    )
    expect(source).not.toHaveBeenCalled()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.cookies).toEqual([
      expect.objectContaining({
        host: 'github.com',
        name: 'user_session',
        value: 'ff-session',
        sameSite: 'lax',
        expires: Math.floor((NOW + 30 * 24 * 60 * 60 * 1000) / 1000),
      }),
      expect.objectContaining({ host: '.github.com', value: 'yes', sameSite: 'unspecified' }),
    ])
  })

  it('refuses Chrome and Edge on Windows', async () => {
    mkdirSync(join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data'), { recursive: true })
    const sources = await listSources(env('win32'), NOW)
    expect(sources).toEqual([
      expect.objectContaining({ browser: 'chrome', unavailable: 'windows-locked' }),
    ])
    expect(
      await readCookies(
        env('win32'),
        { browser: 'chrome', profile: 'Default', sites: ['github.com'] },
        keys(PASSWORD),
        never,
      ),
    ).toEqual({ ok: false, reason: 'unreadable' })
  })
})
