import type { Session, WebContents } from 'electron'
import { describe, expect, it } from 'vitest'
import { isPermissionAllowed, restrictPermissions } from './permissions'

const APP_URL = 'http://localhost:5173/'
const isOwnUrl = (url: string | undefined): boolean => !!url?.startsWith('http://localhost:5173')
const own = { url: APP_URL, isMainFrame: true }

// Every permission name Electron 44 reports, other than the two the app uses.
const DENIED = [
  'ar',
  'automatic-fullscreen',
  'background-fetch',
  'background-sync',
  'captured-surface-control',
  'deprecated-sync-clipboard-read',
  'display-capture',
  'fileSystem',
  'fullscreen',
  'geolocation',
  'geolocation-approximate',
  'hand-tracking',
  'hid',
  'idle-detection',
  'keyboardLock',
  'local-fonts',
  'local-network',
  'local-network-access',
  'loopback-network',
  'media',
  'mediaKeySystem',
  'midi',
  'midiSysex',
  'nfc',
  'notifications',
  'openExternal',
  'payment-handler',
  'periodic-background-sync',
  'persistent-storage',
  'pointerLock',
  'screen-wake-lock',
  'sensors',
  'serial',
  'smart-card',
  'speaker-selection',
  'storage-access',
  'system-wake-lock',
  'top-level-storage-access',
  'usb',
  'vr',
  'web-app-installation',
  'web-printing',
  'window-management',
  'unknown',
]

describe('isPermissionAllowed', () => {
  it.each(['clipboard-read', 'clipboard-sanitized-write'])('grants %s to the app', (permission) => {
    expect(isPermissionAllowed(permission, own, isOwnUrl)).toBe(true)
  })

  it.each(DENIED)('denies %s', (permission) => {
    expect(isPermissionAllowed(permission, own, isOwnUrl)).toBe(false)
  })

  it('denies the clipboard to any other page', () => {
    for (const url of ['https://example.com/', 'devtools://devtools/bundled/', 'about:blank']) {
      expect(isPermissionAllowed('clipboard-read', { url, isMainFrame: true }, isOwnUrl)).toBe(
        false,
      )
    }
  })

  it('denies the clipboard to a frame inside the app', () => {
    const frame = { url: APP_URL, isMainFrame: false }
    expect(isPermissionAllowed('clipboard-sanitized-write', frame, isOwnUrl)).toBe(false)
  })

  it('denies every permission to an artifact, in its frame or alone', () => {
    const artifact = 'kettu-artifact://0123456789abcdef0123456789/'
    for (const permission of [...DENIED, 'clipboard-read', 'clipboard-sanitized-write']) {
      for (const isMainFrame of [false, true]) {
        const context = { url: artifact, isMainFrame }
        expect(isPermissionAllowed(permission, context, isOwnUrl)).toBe(false)
      }
    }
  })

  it('denies a request that has no URL', () => {
    const unknown = { url: undefined, isMainFrame: true }
    expect(isPermissionAllowed('clipboard-read', unknown, isOwnUrl)).toBe(false)
  })
})

interface Handlers {
  request: (...args: unknown[]) => void
  check: (...args: unknown[]) => boolean
  device: () => boolean
}

function installed(isFramed: (webContents: WebContents) => boolean = () => false): Handlers {
  const handlers: Partial<Handlers> = {}
  const session = {
    setPermissionRequestHandler: (handler: Handlers['request']) => (handlers.request = handler),
    setPermissionCheckHandler: (handler: Handlers['check']) => (handlers.check = handler),
    setDevicePermissionHandler: (handler: Handlers['device']) => (handlers.device = handler),
  }
  restrictPermissions(session as unknown as Session, isOwnUrl, isFramed)
  return handlers as Handlers
}

describe('restrictPermissions', () => {
  const webContents = {}

  it('answers requests by the decision', () => {
    const { request } = installed()
    const answers: boolean[] = []
    const details = { isMainFrame: true, requestingUrl: APP_URL }
    request(webContents, 'clipboard-read', (granted: boolean) => answers.push(granted), details)
    request(webContents, 'notifications', (granted: boolean) => answers.push(granted), details)
    expect(answers).toEqual([true, false])
  })

  it('answers checks by the decision', () => {
    const { check } = installed()
    const details = { isMainFrame: true, requestingUrl: APP_URL }
    expect(check(webContents, 'clipboard-sanitized-write', APP_URL, details)).toBe(true)
    expect(check(webContents, 'media', APP_URL, details)).toBe(false)
  })

  it('falls back to the requesting origin when a check has no URL', () => {
    const { check } = installed()
    expect(check(webContents, 'clipboard-read', APP_URL, { isMainFrame: true })).toBe(true)
  })

  it('denies a check made for no window', () => {
    const { check } = installed()
    const details = { isMainFrame: true, requestingUrl: APP_URL }
    expect(check(null, 'clipboard-read', APP_URL, details)).toBe(false)
  })

  it('never grants a device', () => {
    expect(installed().device()).toBe(false)
  })

  it("denies every request and check from an artifact's frame", () => {
    const { request, check } = installed()
    const artifact = 'kettu-artifact://0123456789abcdef0123456789/'
    const details = { isMainFrame: false, requestingUrl: artifact }
    const answers: boolean[] = []
    for (const permission of [...DENIED, 'clipboard-read', 'clipboard-sanitized-write']) {
      request(webContents, permission, (granted: boolean) => answers.push(granted), details)
      answers.push(check(webContents, permission, artifact.slice(0, -1), details))
    }
    expect(answers.every((granted) => !granted)).toBe(true)
  })

  it('denies everything to a page the frame guard does not trust', () => {
    const framed = {}
    const { request, check } = installed((contents) => contents === (framed as WebContents))
    const details = { isMainFrame: true, requestingUrl: APP_URL }
    const answers: boolean[] = []
    request(framed, 'clipboard-read', (granted: boolean) => answers.push(granted), details)
    request(webContents, 'clipboard-read', (granted: boolean) => answers.push(granted), details)
    expect(answers).toEqual([false, true])
    expect(check(framed, 'clipboard-sanitized-write', APP_URL, details)).toBe(false)
    expect(check(webContents, 'clipboard-sanitized-write', APP_URL, details)).toBe(true)
  })
})
