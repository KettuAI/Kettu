import type { Session, WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import {
  BrowserPolicy,
  isAllowedNavigation,
  isForbiddenRequest,
  isHttp,
  isLocalAddress,
  isLocalHost,
  isNeverOpened,
  navigateInPlace,
  stripElectronUserAgent,
} from './policy'

interface Handlers {
  request?: (contents: unknown, permission: string, callback: (allowed: boolean) => void) => void
  check?: (contents: unknown, permission: string) => boolean
  device?: () => boolean
  download?: (event: { preventDefault(): void }, item: unknown, contents: unknown) => void
  filter?: (details: { url: string }, callback: (answer: { cancel: boolean }) => void) => void
}

function fakeSession(): { session: Session; handlers: Handlers } {
  const handlers: Handlers = {}
  const session = {
    getUserAgent: () => 'Mozilla/5.0 (Macintosh) Electron/44.9.2 Chrome/140.0.0.0 Safari/537.36',
    setUserAgent: vi.fn(),
    setPermissionRequestHandler: (handler: NonNullable<Handlers['request']>) => {
      handlers.request = handler
    },
    setPermissionCheckHandler: (handler: NonNullable<Handlers['check']>) => {
      handlers.check = handler
    },
    setDevicePermissionHandler: (handler: NonNullable<Handlers['device']>) => {
      handlers.device = handler
    },
    on: (event: string, handler: NonNullable<Handlers['download']>) => {
      if (event === 'will-download') handlers.download = handler
    },
    webRequest: {
      onBeforeRequest: (handler: NonNullable<Handlers['filter']>) => {
        handlers.filter = handler
      },
    },
  } as unknown as Session
  return { session, handlers }
}

describe('scheme rules', () => {
  it('opens http, https and an empty document at the top level', () => {
    expect(isAllowedNavigation('https://example.com')).toBe(true)
    expect(isAllowedNavigation('http://localhost:5173')).toBe(true)
    expect(isAllowedNavigation('about:blank')).toBe(true)
    expect(isAllowedNavigation('about:srcdoc')).toBe(true)
  })

  it('never opens anything else at the top level', () => {
    for (const url of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,hi',
      'blob:https://example.com/id',
      'chrome://settings',
      'devtools://devtools/bundled/inspector.html',
      'view-source:https://example.com',
      'overbench-artifact://abc/index.html',
      'overbench-media://token/photo.png',
      'not a url',
    ]) {
      expect(isAllowedNavigation(url), url).toBe(false)
    }
  })

  it('takes only http and https addresses from the pane', () => {
    expect(isHttp('https://example.com/')).toBe(true)
    expect(isHttp('http://127.0.0.1:3000/')).toBe(true)
    expect(isHttp('file:///x')).toBe(false)
    expect(isHttp('not a url')).toBe(false)
  })
})

describe('requests', () => {
  it('cancels local files, OverBench schemes and the artifacts service', () => {
    expect(isForbiddenRequest('file:///etc/passwd', null)).toBe(true)
    expect(isForbiddenRequest('overbench-artifact://abc/index.html', null)).toBe(true)
    expect(isForbiddenRequest('overbench-media://token/photo.png', null)).toBe(true)
    expect(isForbiddenRequest('http://127.0.0.1:41234/mcp', 41234)).toBe(true)
    expect(isForbiddenRequest('http://localhost:41234/mcp', 41234)).toBe(true)
    expect(isForbiddenRequest('https://example.com/x', 41234)).toBe(false)
    expect(isForbiddenRequest('http://127.0.0.1:5173/app.js', 41234)).toBe(false)
    expect(isForbiddenRequest('http://127.0.0.1:41234/mcp', null)).toBe(false)
  })
})

describe('BrowserPolicy', () => {
  it('takes Electron out of the user agent', () => {
    expect(stripElectronUserAgent('a Electron/44.9.2 b')).toBe('a b')
    expect(stripElectronUserAgent('a Electron/44.9.2')).toBe('a')
  })

  it('denies every permission, from the partition', () => {
    const { session, handlers } = fakeSession()
    new BrowserPolicy(session, { downloadBlocked: () => {} }).install()
    const permissions = [
      'camera',
      'microphone',
      'geolocation',
      'notifications',
      'clipboard-read',
      'midi',
      'midiSysex',
      'pointerLock',
      'fullscreen',
      'openExternal',
      'speaker-selection',
      'storage-access',
      'top-level-storage-access',
      'window-management',
      'unknown',
    ]
    for (const permission of permissions) {
      const answer = vi.fn()
      handlers.request?.(null, permission, answer)
      expect(answer, permission).toHaveBeenCalledWith(false)
      expect(handlers.check?.(null, permission), permission).toBe(false)
    }
    expect(handlers.device?.()).toBe(false)
  })

  it('cancels a download and says which page asked for it', () => {
    const blocked: unknown[] = []
    const { session, handlers } = fakeSession()
    new BrowserPolicy(session, { downloadBlocked: (contents) => blocked.push(contents) }).install()
    const event = { preventDefault: vi.fn() }
    const contents = { id: 7 }
    handlers.download?.(event, { getFilename: () => 'x.pdf' }, contents)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(blocked).toEqual([contents])
  })

  it('cancels forbidden requests and lets the web through', () => {
    const { session, handlers } = fakeSession()
    const policy = new BrowserPolicy(session, { downloadBlocked: () => {} })
    policy.install()
    policy.setServicePort(41234)
    const cancel = (url: string): boolean => {
      let answer: { cancel: boolean } | null = null
      handlers.filter?.({ url }, (next) => (answer = next))
      return answer!.cancel
    }
    expect(cancel('file:///etc/passwd')).toBe(true)
    expect(cancel('overbench-media://token/x')).toBe(true)
    expect(cancel('http://127.0.0.1:41234/mcp')).toBe(true)
    expect(cancel('https://example.com/app.js')).toBe(false)
  })
})

describe('navigateInPlace', () => {
  it('opens an http(s) link in the same page and refuses anything else', () => {
    const loadURL = vi.fn(async () => {})
    const contents = { loadURL } as unknown as WebContents
    navigateInPlace(contents, 'https://example.com/')
    expect(loadURL).toHaveBeenCalledWith('https://example.com/')
    navigateInPlace(contents, 'javascript:alert(1)')
    navigateInPlace(contents, 'file:///etc/passwd')
    expect(loadURL).toHaveBeenCalledTimes(1)
  })
})

describe('the addresses an agent may open', () => {
  it('takes a dev server on this machine and the empty document', () => {
    for (const url of [
      'http://localhost:5173/',
      'http://127.0.0.1:3000/app',
      'http://[::1]:8080/',
      'https://app.localhost/',
      'http://myapp.test/login',
      'about:blank',
    ]) {
      expect(isLocalAddress(new URL(url))).toBe(true)
    }
  })

  it('leaves every other origin to the user', () => {
    for (const url of [
      'https://example.com/',
      'http://localhost.example.com/',
      'https://test.example.org/',
      'ftp://127.0.0.1/',
    ]) {
      expect(isLocalAddress(new URL(url))).toBe(false)
    }
  })

  it('names the hosts that count as local', () => {
    expect(isLocalHost('localhost')).toBe(true)
    expect(isLocalHost('LOCALHOST')).toBe(true)
    expect(isLocalHost('127.0.0.1')).toBe(true)
    expect(isLocalHost('[::1]')).toBe(true)
    expect(isLocalHost('a.b.localhost')).toBe(true)
    expect(isLocalHost('a.test')).toBe(true)
    expect(isLocalHost('example.com')).toBe(false)
    expect(isLocalHost('localhost.com')).toBe(false)
  })

  it('never opens a scheme that reaches this machine or another app', () => {
    for (const url of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,hi',
      'blob:https://example.com/x',
      'chrome://settings',
      'devtools://devtools/bundled/inspector.html',
      'view-source:https://example.com/',
      'overbench-artifact://abc/',
    ]) {
      expect(isNeverOpened(new URL(url))).toBe(true)
    }
    expect(isNeverOpened(new URL('https://example.com/'))).toBe(false)
  })
})
