import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Session } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { restrictPermissions } from './permissions'

const toolkit = vi.hoisted(() => ({ is: { dev: false } }))
vi.mock('@electron-toolkit/utils', () => toolkit)

async function importRenderer(dev: boolean, devServerUrl?: string) {
  vi.resetModules()
  toolkit.is.dev = dev
  vi.stubEnv('ELECTRON_RENDERER_URL', devServerUrl)
  return import('./renderer')
}

afterEach(() => {
  vi.unstubAllEnvs()
})

const { matchesRendererEntry } = await importRenderer(false)

const garbage = [undefined, '', ' ', 'garbage', 'index.html', '//index.html', 'about:blank']

describe('matchesRendererEntry with the dev server', () => {
  const entry = { kind: 'dev-server', url: 'http://localhost:5173' } as const

  it.each([
    'http://localhost:5173',
    'http://localhost:5173/',
    'http://localhost:5173/?t=1',
    'http://localhost:5173/#/settings',
    'http://localhost:5173/src/main.tsx',
  ])('accepts its own origin: %s', (url) => {
    expect(matchesRendererEntry(url, entry)).toBe(true)
  })

  it.each([
    'http://localhost:51730/',
    'http://localhost:5174/',
    'http://localhost:5173@evil.example.com/',
    'http://localhost:5173.example.com/',
    'http://localhost.example.com:5173/',
    'https://localhost:5173/',
    'http://127.0.0.1:5173/',
    'ws://localhost:5173/',
    'file:///index.html',
    'data:text/html,<p>x</p>',
    'blob:null/1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed',
    ...garbage,
  ])('rejects %s', (url) => {
    expect(matchesRendererEntry(url, entry)).toBe(false)
  })

  it('matches nothing when the dev server URL is unusable', () => {
    for (const url of ['', 'not a url', 'file:///index.html', 'data:text/html,x']) {
      expect(matchesRendererEntry('file:///index.html', { kind: 'dev-server', url })).toBe(false)
      expect(matchesRendererEntry('data:text/html,x', { kind: 'dev-server', url })).toBe(false)
    }
  })
})

describe.each([
  ['darwin', '/Applications/OverBench.app/Contents/Resources/app.asar/out/renderer/index.html'],
  ['linux', '/opt/OverBench/resources/app.asar/out/renderer/index.html'],
] as const)('matchesRendererEntry with a built file on %s', (platform, path) => {
  const entry = { kind: 'file', path } as const
  const href = pathToFileURL(path, { windows: false }).href
  const matches = (url: string | undefined): boolean => matchesRendererEntry(url, entry, platform)

  it('accepts the entry itself, ignoring query and hash', () => {
    expect(matches(href)).toBe(true)
    expect(matches(`${href}#/settings`)).toBe(true)
    expect(matches(`${href}?a=1`)).toBe(true)
    expect(matches(`${href}?a=1#b`)).toBe(true)
    expect(matches(href.replace('file://', 'file://localhost'))).toBe(true)
  })

  it.each([
    href.replace('index.html', 'other.html'),
    href.replace('index.html', ''),
    href.replace('/renderer/index.html', '/index.html'),
    href.replace('/renderer/index.html', '/renderer/sub/index.html'),
    href.replace('/renderer/', '/renderer/../../evil/'),
    href.replace('index.html', 'INDEX.HTML'),
    `${href}.bak`,
    `${href}%00`,
    href.replace('/renderer/index.html', '/renderer%2Findex.html'),
    href.replace('file://', 'file://evil.example.com'),
    'file:///etc/passwd',
    'file:///tmp/index.html',
    'file:///index.html',
    'file://',
    href.replace('file:', 'http:'),
    `http://localhost:5173${path}`,
    ...garbage,
  ])('rejects %s', (url) => {
    expect(matches(url)).toBe(false)
  })

  it('accepts the entry however its path is escaped', () => {
    const odd = { kind: 'file', path: '/Users/José Doe/x{1}/out/renderer/index.html' } as const
    for (const url of [
      'file:///Users/Jos%C3%A9%20Doe/x%7B1%7D/out/renderer/index.html',
      'file:///Users/Jos%C3%A9%20Doe/x{1}/out/renderer/index.html',
      'file:///Users/José Doe/x{1}/out/renderer/index.html',
    ]) {
      expect(matchesRendererEntry(url, odd, platform)).toBe(true)
    }
    expect(
      matchesRendererEntry(
        'file:///Users/Jose%20Doe/x%7B1%7D/out/renderer/index.html',
        odd,
        platform,
      ),
    ).toBe(false)
  })

  // loadFile leaves a '%' as it is, and Chromium keeps one that starts no escape.
  it.each([
    [
      '/Users/ada/Apps 100%/OverBench.app/Contents/Resources/app.asar/out/renderer/index.html',
      'file:///Users/ada/Apps%20100%/OverBench.app/Contents/Resources/app.asar/out/renderer/index.html',
    ],
    [
      '/tmp/pct%zz/.mount_OverBe1/resources/app.asar/out/renderer/index.html',
      'file:///tmp/pct%zz/.mount_OverBe1/resources/app.asar/out/renderer/index.html',
    ],
    ['/opt/%/x%4/out/renderer/index.html', 'file:///opt/%/x%4/out/renderer/index.html'],
  ])('accepts an install path with a literal percent sign: %s', (entryPath, url) => {
    const pct = { kind: 'file', path: entryPath } as const
    expect(matchesRendererEntry(url, pct, platform)).toBe(true)
    expect(matchesRendererEntry(`${url}?a=1#/settings`, pct, platform)).toBe(true)
    const escaped = pathToFileURL(entryPath, { windows: false }).href
    expect(matchesRendererEntry(escaped, pct, platform)).toBe(true)
    expect(matchesRendererEntry(url.replace('index.html', 'other.html'), pct, platform)).toBe(false)
    expect(matchesRendererEntry(url.replaceAll('%', ''), pct, platform)).toBe(false)
  })
})

describe('matchesRendererEntry with a built file on win32', () => {
  const path =
    'C:\\Users\\Ada\\AppData\\Local\\Programs\\OverBench\\resources\\app.asar\\out\\renderer\\index.html'
  const entry = { kind: 'file', path } as const
  const href = pathToFileURL(path, { windows: true }).href
  const matches = (url: string | undefined): boolean => matchesRendererEntry(url, entry, 'win32')

  it('accepts the entry however Chromium spells the drive, separators and case', () => {
    expect(href).toBe(
      'file:///C:/Users/Ada/AppData/Local/Programs/OverBench/resources/app.asar/out/renderer/index.html',
    )
    expect(matches(href)).toBe(true)
    expect(matches(`${href}#/settings`)).toBe(true)
    expect(matches(`${href}?a=1#b`)).toBe(true)
    expect(matches(href.replace('file:///C:', 'file:///c:'))).toBe(true)
    expect(matches(href.replace('file:///C:', 'file:///C|'))).toBe(true)
    expect(matches(`file:///${path}`)).toBe(true)
    expect(matches(href.replace('/Users/Ada/', '/USERS/ADA/'))).toBe(true)
  })

  it.each([
    href.replace('index.html', 'other.html'),
    href.replace('/renderer/index.html', '/index.html'),
    href.replace('/renderer/', '/renderer/../../evil/'),
    href.replace('file:///C:', 'file:///D:'),
    href.replace('/renderer/index.html', '/renderer%5Cindex.html'),
    href.replace('/renderer/index.html', '/renderer%2Findex.html'),
    href.replace('file:///C:', 'file://evil.example.com/C:'),
    'file://server/share/OverBench/resources/app.asar/out/renderer/index.html',
    'file:///Users/Ada/AppData/Local/Programs/OverBench/resources/app.asar/out/renderer/index.html',
    'file:///C:/Windows/System32/index.html',
    `${href}.bak`,
    ...garbage,
  ])('rejects %s', (url) => {
    expect(matches(url)).toBe(false)
  })

  it.each([
    [
      'C:\\Users\\Ada 100%\\AppData\\Local\\Programs\\OverBench\\resources\\app.asar\\out\\renderer\\index.html',
      'file:///C:/Users/Ada%20100%/AppData/Local/Programs/OverBench/resources/app.asar/out/renderer/index.html',
    ],
    [
      'D:\\pct%zz\\OverBench\\resources\\app.asar\\out\\renderer\\index.html',
      'file:///D:/pct%zz/OverBench/resources/app.asar/out/renderer/index.html',
    ],
  ])('accepts an install path with a literal percent sign: %s', (entryPath, url) => {
    const pct = { kind: 'file', path: entryPath } as const
    expect(matchesRendererEntry(url, pct, 'win32')).toBe(true)
    expect(matchesRendererEntry(`${url}?a=1#/settings`, pct, 'win32')).toBe(true)
    const escaped = pathToFileURL(entryPath, { windows: true }).href
    expect(matchesRendererEntry(escaped, pct, 'win32')).toBe(true)
    expect(matchesRendererEntry(url.replace('index.html', 'other.html'), pct, 'win32')).toBe(false)
    expect(matchesRendererEntry(url.replaceAll('%', ''), pct, 'win32')).toBe(false)
  })

  it('folds the case of ASCII letters only', () => {
    const kim = {
      kind: 'file',
      path: 'C:\\Users\\kim\\AppData\\Local\\Programs\\OverBench\\resources\\app.asar\\out\\renderer\\index.html',
    } as const
    const url =
      'file:///C:/Users/kim/AppData/Local/Programs/OverBench/resources/app.asar/out/renderer/index.html'
    // U+212A KELVIN SIGN lowercases to "k", but NTFS keeps it a different name.
    const kelvinUrl = url.replace('/kim/', '/\u212Aim/')
    expect(matchesRendererEntry(url.replace('/kim/', '/KIM/'), kim, 'win32')).toBe(true)
    expect(matchesRendererEntry(kelvinUrl, kim, 'win32')).toBe(false)
    const kelvin = { kind: 'file', path: kim.path.replace('kim', '\u212Aim') } as const
    expect(matchesRendererEntry(kelvinUrl, kelvin, 'win32')).toBe(true)
    expect(matchesRendererEntry(url, kelvin, 'win32')).toBe(false)
  })

  it('accepts an entry on a network share only from that share', () => {
    const unc = {
      kind: 'file',
      path: '\\\\server\\share\\OverBench\\resources\\app.asar\\out\\renderer\\index.html',
    } as const
    const url = 'file://server/share/OverBench/resources/app.asar/out/renderer/index.html'
    expect(matchesRendererEntry(url, unc, 'win32')).toBe(true)
    expect(matchesRendererEntry(`${url}#/x`, unc, 'win32')).toBe(true)
    expect(matchesRendererEntry(url.replace('//server/', '//other/'), unc, 'win32')).toBe(false)
    expect(matchesRendererEntry(url.replace('/share/', '/other/'), unc, 'win32')).toBe(false)
    // URLs lower-case the host.
    const upper = { kind: 'file', path: unc.path.replace('server', 'SERVER') } as const
    expect(matchesRendererEntry(url, upper, 'win32')).toBe(true)
  })
})

describe('isRendererUrl', () => {
  const builtEntry = join(dirname(fileURLToPath(import.meta.url)), '../renderer/index.html')
  const builtHref = pathToFileURL(builtEntry).href

  it('in a packaged build, accepts only the index.html loadRenderer loads', async () => {
    const { isRendererUrl } = await importRenderer(false, 'http://localhost:5173')
    expect(isRendererUrl(builtHref)).toBe(true)
    expect(isRendererUrl(`${builtHref}#/settings`)).toBe(true)
    expect(isRendererUrl(pathToFileURL(join(builtEntry, '../other.html')).href)).toBe(false)
    expect(isRendererUrl(pathToFileURL(fileURLToPath(import.meta.url)).href)).toBe(false)
    expect(isRendererUrl('file:///etc/passwd')).toBe(false)
    expect(isRendererUrl('http://localhost:5173/')).toBe(false)
    expect(isRendererUrl(undefined)).toBe(false)
  })

  it('in development, accepts only the dev server origin', async () => {
    const { isRendererUrl } = await importRenderer(true, 'http://localhost:5173')
    expect(isRendererUrl('http://localhost:5173/')).toBe(true)
    expect(isRendererUrl('http://localhost:5173/#/settings')).toBe(true)
    expect(isRendererUrl('http://localhost:51730/')).toBe(false)
    expect(isRendererUrl('http://localhost:5173@evil.example.com/')).toBe(false)
    expect(isRendererUrl(builtHref)).toBe(false)
    expect(isRendererUrl('')).toBe(false)
  })

  it('in development without a dev server, accepts the built index.html', async () => {
    const { isRendererUrl } = await importRenderer(true)
    expect(isRendererUrl(builtHref)).toBe(true)
    expect(isRendererUrl('file:///etc/passwd')).toBe(false)
  })
})

describe('the permission handlers with isRendererUrl', () => {
  const builtHref = pathToFileURL(
    join(dirname(fileURLToPath(import.meta.url)), '../renderer/index.html'),
  ).href
  const webContents = {}

  function install(isOwnUrl: (url: string | undefined) => boolean): {
    request: (...args: unknown[]) => void
    check: (...args: unknown[]) => boolean
  } {
    const handlers: Record<string, unknown> = {}
    const session = {
      setPermissionRequestHandler: (handler: unknown) => (handlers['request'] = handler),
      setPermissionCheckHandler: (handler: unknown) => (handlers['check'] = handler),
      setDevicePermissionHandler: () => {},
    }
    restrictPermissions(session as unknown as Session, isOwnUrl, () => false)
    return handlers as ReturnType<typeof install>
  }

  // Electron passes a frame's last committed URL, hash included, and its origin, which for a
  // file is file:/// whatever the path; with no frame there is no URL and no web contents.
  it('grants the clipboard to the packaged page, in checks and requests', async () => {
    const { isRendererUrl } = await importRenderer(false)
    const { check, request } = install(isRendererUrl)
    const details = { isMainFrame: true, requestingUrl: `${builtHref}#/settings` }
    expect(check(webContents, 'clipboard-read', 'file:///', details)).toBe(true)
    expect(check(webContents, 'clipboard-sanitized-write', 'file:///', details)).toBe(true)
    const answers: boolean[] = []
    request(webContents, 'clipboard-read', (granted: boolean) => answers.push(granted), details)
    expect(answers).toEqual([true])
  })

  it('denies the clipboard to any other file, and to the file origin alone', async () => {
    const { isRendererUrl } = await importRenderer(false)
    const { check } = install(isRendererUrl)
    const other = pathToFileURL(fileURLToPath(import.meta.url)).href
    expect(
      check(webContents, 'clipboard-read', 'file:///', { isMainFrame: true, requestingUrl: other }),
    ).toBe(false)
    expect(check(webContents, 'clipboard-read', 'file:///', { isMainFrame: true })).toBe(false)
    expect(check(null, 'clipboard-read', 'file:///', { isMainFrame: false })).toBe(false)
  })

  it('grants the clipboard to the dev server page', async () => {
    const { isRendererUrl } = await importRenderer(true, 'http://localhost:5173')
    const { check } = install(isRendererUrl)
    const origin = 'http://localhost:5173/'
    const details = { isMainFrame: true, requestingUrl: 'http://localhost:5173/#/settings' }
    expect(check(webContents, 'clipboard-read', origin, details)).toBe(true)
    expect(check(webContents, 'clipboard-sanitized-write', origin, details)).toBe(true)
    const lookalike = { isMainFrame: true, requestingUrl: 'http://localhost:51730/' }
    expect(check(webContents, 'clipboard-read', 'http://localhost:51730/', lookalike)).toBe(false)
  })
})
