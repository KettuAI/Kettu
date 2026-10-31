// The Remote access page's parts in each state they show, rendered to markup.

import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PairedDevice } from '@shared/remote/device'
import type { DirectAddress } from '@shared/remote/protocol'
import type { RemoteStatus } from '@shared/remote/status'
import { DEFAULT_SETTINGS, type SettingsFile } from '@shared/settings'

vi.stubGlobal('window', {
  kettu: { platform: 'darwin', remote: { activity: () => new Promise(() => {}) } },
  matchMedia: () => ({ matches: false, addEventListener: () => {} }),
})
// Server rendering reads no store and no clock, so the test hands them over.
const remote = vi.hoisted(() => ({ status: null as RemoteStatus | null }))
vi.mock('@renderer/stores/remote', () => ({
  useRemoteStore: (select: (state: { status: RemoteStatus | null }) => unknown) =>
    select({ status: remote.status }),
}))
const settings = vi.hoisted(() => ({ own: [] as DirectAddress[] }))
vi.mock('@renderer/stores/settings', () => {
  const state = () => {
    const file: SettingsFile = structuredClone(DEFAULT_SETTINGS)
    file.remote = {
      enabled: true,
      name: null,
      direct: { enabled: true, port: 47821, addresses: settings.own },
    }
    return { settings: file, update: async () => {} }
  }
  const useSettingsStore = (select: (s: ReturnType<typeof state>) => unknown) => select(state())
  useSettingsStore.getState = state
  return { useSettingsStore }
})
vi.mock('@renderer/components/refresh', () => ({
  useRefresh: () => ({ run: (action: () => Promise<unknown>) => action(), phase: 'idle' }),
}))
vi.mock('@renderer/lib/use-now', () => ({ useNow: () => Date.now(), useSeconds: () => Date.now() }))

const { i18n } = await import('@renderer/lib/i18n')
const { Dialog } = await import('@renderer/components/ui/dialog')
const { DeviceRow, NoDevices, RemoteStatusRow, StaleNote } = await import('./remote-section')
const { CodeBody, Confirm } = await import('./remote-pairing')
const { DevicePage } = await import('./remote-device')
const { DirectPortField, FoundAddresses, OwnAddresses } = await import('./remote-direct')
const { addressText, parseAddress, parsePort } = await import('./remote-text')
const { qrPath } = await import('./qr-path')
const { encode } = await import('uqr')

const DAY = 24 * 60 * 60 * 1000
const now = Date.now()
const WIFI = { host: '192.168.1.8', port: 47821 }
const TAILSCALE = { host: '100.88.12.7', port: 47821 }
const FRP = { host: '203.0.113.24', port: 60021 }

const phone: PairedDevice = {
  id: 'a'.repeat(32),
  publicKey: 'key',
  name: 'My iPhone',
  kind: 'ios',
  platform: 'iOS 26.1',
  model: 'iPhone 17 Pro',
  addedAt: now - 10 * DAY,
  lastConnectedAt: now - 3 * DAY,
}

function status(patch: Partial<RemoteStatus> = {}): RemoteStatus {
  return {
    state: 'on',
    hostName: 'Studio',
    systemName: 'Studio',
    devices: [phone],
    online: [],
    plainTextKey: false,
    direct: { state: 'listening', port: 47821, addresses: [WIFI, TAILSCALE] },
    ...patch,
  }
}

/** The markup's text, tags and entities left out. */
const text = (element: ReactElement): string =>
  renderToStaticMarkup(element)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()

afterEach(async () => {
  remote.status = null
  settings.own = []
  await i18n.changeLanguage('en')
})

describe('the status line', () => {
  it('says remote access is on, the port it listens on and how many devices are online', () => {
    expect(text(createElement(RemoteStatusRow, { status: status() }))).toBe(
      'On · Listening on port 47821 · No device online',
    )
    expect(text(createElement(RemoteStatusRow, { status: status({ online: [phone.id] }) }))).toBe(
      'On · Listening on port 47821 · 1 device online',
    )
    expect(
      text(
        createElement(RemoteStatusRow, {
          status: status({ devices: [], direct: { state: 'off' } }),
        }),
      ),
    ).toBe('On · No devices yet')
  })

  it('says why it cannot listen, with Change port and Retry', () => {
    const failed = status({ direct: { state: 'failed', port: 47821, reason: 'port_in_use' } })
    expect(text(createElement(RemoteStatusRow, { status: failed }))).toBe(
      'Could not listen on port 47821 Another program is using this port. Pick another port, or ' +
        'close that program and retry. Change port Retry',
    )
  })

  it('says it is starting, or why it could not', () => {
    expect(text(createElement(RemoteStatusRow, { status: status({ state: 'starting' }) }))).toBe(
      'Starting…',
    )
    expect(text(createElement(RemoteStatusRow, { status: status({ state: 'failed' }) }))).toMatch(
      /^Remote access could not start The system could not unlock/,
    )
  })

  it('reads in Chinese', async () => {
    await i18n.changeLanguage('zh-CN')
    expect(text(createElement(RemoteStatusRow, { status: status({ online: [phone.id] }) }))).toBe(
      '已打开 · 在端口 47821 监听 · 1 台设备在线',
    )
    const failed = status({ direct: { state: 'failed', port: 47821, reason: 'port_in_use' } })
    expect(text(createElement(RemoteStatusRow, { status: failed }))).toBe(
      '没能在端口 47821 监听 这个端口被别的程序占用了。换个端口，或者关掉那个程序再重试。 换个端口 重试',
    )
  })
})

describe('the Direct group', () => {
  it('shows the port to edit', () => {
    const markup = renderToStaticMarkup(createElement(DirectPortField, { label: 'Port' }))
    expect(markup).toContain('id="remote-direct-port"')
    expect(markup).toContain('value="47821"')
  })

  it("lists the addresses found apart from the owner's own", () => {
    settings.own = [FRP]
    remote.status = status({ direct: { state: 'listening', port: 47821, addresses: [FRP, WIFI] } })
    expect(text(createElement(FoundAddresses, { text: 'Found' }))).toBe('Found 192.168.1.8:47821')
    expect(text(createElement(OwnAddresses, { text: 'Own' }))).toBe('Own 203.0.113.24:60021 Add')
    remote.status = status({ direct: { state: 'failed', port: 47821, reason: 'other' } })
    expect(text(createElement(FoundAddresses, { text: 'Found' }))).toBe(
      'Found Shown once the port is listening.',
    )
  })

  it("takes no address beyond the owner's tenth", () => {
    settings.own = Array.from({ length: 10 }, (_, i) => ({ host: 'a.example', port: 1000 + i }))
    expect(text(createElement(OwnAddresses, { text: 'Own' }))).toMatch(
      /You can add up to 10 addresses\.$/,
    )
  })
})

describe('addresses as the owner types them', () => {
  it('read a host name or an IP address and a port', () => {
    expect(parseAddress(' frp.example.com:60021 ')).toEqual({
      host: 'frp.example.com',
      port: 60021,
    })
    expect(parseAddress('203.0.113.24:60021')).toEqual(FRP)
    expect(parseAddress('[fd3c:9a1e:5b20::8]:47821')).toEqual({
      host: 'fd3c:9a1e:5b20::8',
      port: 47821,
    })
    for (const wrong of [
      'https://frp.example.com',
      'https://frp.example.com:443',
      'frp.example.com',
      'frp.example.com:0',
      'frp.example.com:65536',
      'fd3c::8:47821',
      'frp example.com:1',
      '10.1:7000',
      '',
    ]) {
      expect(parseAddress(wrong)).toBeNull()
    }
  })

  it('write an IPv6 address in brackets', () => {
    expect(addressText({ host: 'fd3c:9a1e:5b20::8', port: 47821 })).toBe(
      '[fd3c:9a1e:5b20::8]:47821',
    )
    expect(addressText(WIFI)).toBe('192.168.1.8:47821')
  })

  it('take a port from 1024', () => {
    expect(parsePort(' 50123 ')).toBe(50123)
    for (const wrong of ['1023', '65536', '5012a', '', '-1', '1e4'])
      expect(parsePort(wrong)).toBeNull()
  })
})

describe('a device row', () => {
  it('names the device, what it runs, and that it is online', () => {
    const row = text(createElement(DeviceRow, { device: phone, online: true }))
    expect(row).toBe('My iPhone iOS app · iPhone 17 Pro · iOS 26.1 Online')
  })

  it('says when it last connected', () => {
    expect(text(createElement(DeviceRow, { device: phone, online: false }))).toContain(
      'Connected 3 days ago',
    )
    const never = { ...phone, lastConnectedAt: null, addedAt: now }
    expect(text(createElement(DeviceRow, { device: never, online: false }))).toContain(
      'Never connected',
    )
  })

  it('says when it will be removed in its last 7 days', () => {
    const stale = { ...phone, lastConnectedAt: now - 85 * DAY - 60_000 }
    expect(text(createElement(DeviceRow, { device: stale, online: false }))).toContain(
      'Removed in 5 days',
    )
    // Online, it is seen now.
    expect(text(createElement(DeviceRow, { device: stale, online: true }))).not.toContain('Removed')
  })
})

describe('the list', () => {
  it('without devices says how to add one', () => {
    expect(text(createElement(NoDevices))).toBe(
      'No devices yet Scan the code with Kettu on an iPhone or iPad, or paste the link in Kettu on another computer. Add device…',
    )
  })

  it('notes a device in its last days', () => {
    const stale = { ...phone, lastConnectedAt: now - 85 * DAY - 60_000 }
    remote.status = status({ devices: [stale, { ...phone, id: 'b'.repeat(32) }] })
    expect(text(createElement(StaleNote))).toBe(
      'Devices not connected for 90 days are removed. “My iPhone” has not connected for 85 days; connecting once in the next 5 days keeps it.',
    )
    remote.status = status({ devices: [stale], online: [stale.id] })
    expect(renderToStaticMarkup(createElement(StaleNote))).toBe('')
  })
})

describe('Add device', () => {
  const link = 'https://kettu.sh/pair#AQID'
  const waiting = { state: 'waiting' as const, link, expiresAt: now + 4 * 60_000 + 32_000 }

  it('shows the code as a QR code and a link, and the time left', () => {
    const markup = renderToStaticMarkup(
      createElement(CodeBody, { shown: { kind: 'pairing', pairing: waiting }, link }),
    )
    expect(markup).toContain('aria-label="Pairing QR code"')
    expect(markup).toContain('fill-canvas-ink')
    const body = text(
      createElement(CodeBody, { shown: { kind: 'pairing', pairing: waiting }, link }),
    )
    expect(body).toContain('Scan this code with Kettu on an iPhone or iPad.')
    expect(body).toContain(link)
    expect(body).toMatch(/expires in 4:3[12] ?\./)
  })

  it.each([
    ['expired', 'This code has expired'],
    ['attempts', 'Too many tries, so this code is void'],
    ['rejected', 'You rejected the device, so this code is void'],
  ] as const)('says why a code is void: %s', (reason, title) => {
    const shown = { kind: 'pairing' as const, pairing: { state: 'void' as const, reason } }
    const body = text(createElement(CodeBody, { shown, link }))
    expect(body).toContain('Expired')
    expect(body).toContain(title)
    expect(body).not.toContain('expires in')
    // The link stays, greyed out, and copies no more.
    expect(renderToStaticMarkup(createElement(CodeBody, { shown, link }))).toMatch(
      /text-disabled[^>]*>https:\/\/kettu\.sh\/pair#AQID/,
    )
  })

  it('asks whether to add the device, with its name to edit', () => {
    const pairing = {
      state: 'confirm' as const,
      device: {
        name: 'iPad Air',
        model: 'iPad Air',
        kind: 'ios',
        platform: 'iPadOS 26.1',
        known: false,
      },
    }
    const confirm = createElement(
      Dialog,
      null,
      createElement(Confirm, { pairing, onAnswer: () => {} }),
    )
    expect(renderToStaticMarkup(confirm)).toContain('value="iPad Air"')
    const body = text(confirm)
    expect(body).toContain('Add this device?')
    expect(body).toContain('iOS app · iPadOS 26.1 · Just connected with this code')
    expect(body).toMatch(/Reject Add$/)
  })
})

describe("a device's page", () => {
  it('has when it joined and last connected, its activity and Remove', () => {
    remote.status = status({ online: [phone.id] })
    const page = text(createElement(DevicePage, { id: phone.id }))
    expect(page).toContain('My iPhone')
    expect(page).toContain('Online')
    expect(page).toContain('Joined')
    expect(page).toMatch(/from a scanned code/)
    expect(page).toMatch(/Online now, connected at/)
    expect(page).toContain('Activity Last 30 days')
    expect(page).toContain('Remove this device')
  })

  it('says when the device is gone', () => {
    remote.status = status({ devices: [] })
    expect(text(createElement(DevicePage, { id: phone.id }))).toContain(
      'This device is no longer paired.',
    )
  })
})

describe('qrPath', () => {
  it('draws every dark module once', () => {
    const value = 'https://kettu.sh/pair#AQIDBAUGBwgJ'
    const { data, size } = encode(value, { ecc: 'L', border: 0 })
    const { size: drawn, path } = qrPath(value)
    expect(drawn).toBe(size)
    const width = [...path.matchAll(/h(\d+)v1/g)].reduce((sum, run) => sum + Number(run[1]), 0)
    expect(width).toBe(data.flat().filter(Boolean).length)
  })
})
