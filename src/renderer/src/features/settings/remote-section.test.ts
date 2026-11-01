// The Remote access page's parts in each state they show, rendered to markup.

import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { addressText, parseAddress, parsePort } from '@shared/remote/address'
import type { DeviceActivity } from '@shared/remote/activity'
import type { PairedDevice } from '@shared/remote/device'
import type { DirectAddress } from '@shared/remote/protocol'
import { pairingLink, parseBrowserPairingLink, parsePairingLink } from '@shared/remote/pairing'
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
const settings = vi.hoisted(() => ({ own: [] as DirectAddress[], enabled: true, terminal: false }))
vi.mock('@renderer/stores/settings', () => {
  const state = () => {
    const file: SettingsFile = structuredClone(DEFAULT_SETTINGS)
    file.remote = {
      enabled: settings.enabled,
      name: null,
      direct: { enabled: true, port: 47821, addresses: settings.own },
      terminal: settings.terminal,
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
const {
  AddDeviceRow,
  DeviceRow,
  NoDevices,
  PlainKeyNote,
  RemoteStatusRow,
  StaleNote,
  TerminalSwitch,
} = await import('./remote-section')
const { CodeBody, Confirm } = await import('./remote-pairing')
const { browserLinks } = await import('./pair-links')
const { closeRequest } = await import('./pair-close')
const { changeDevice, deviceLine } = await import('./remote-text')
const { platformName } = await import('./host-text')
const { ActivityRow, DevicePage } = await import('./remote-device')
const { useRemoteSection } = await import('./section-defs')
const { DirectPortField, FoundAddresses, OwnAddresses } = await import('./remote-direct')
const { qrPath } = await import('./qr-path')
const { encode } = await import('uqr')

const DAY = 24 * 60 * 60 * 1000
const now = Date.now()
/** The page's own translations, in the language now chosen. */
const t = () => i18n.getFixedT(null, 'settings')
const WIFI = { host: '192.168.1.8', port: 47821 }
const TAILSCALE = { host: '100.88.12.7', port: 47821 }
const FRP = { host: '203.0.113.24', port: 60021 }

const phone: PairedDevice = {
  id: 'a'.repeat(32),
  publicKey: 'key',
  name: 'My iPhone',
  kind: 'ios',
  platform: 'ios',
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
  settings.enabled = true
  settings.terminal = false
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

describe('the key kept in a file', () => {
  it('is noted only when the system has no keyring', () => {
    remote.status = status({ plainTextKey: true })
    expect(text(createElement(PlainKeyNote))).toBe(
      "This computer's key is kept in a file only your user can read, because the system has no keyring.",
    )
    remote.status = status()
    expect(renderToStaticMarkup(createElement(PlainKeyNote))).toBe('')
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

describe('Allow terminal', () => {
  it('is a switch for the setting, off until the owner turns it on', () => {
    const markup = () =>
      renderToStaticMarkup(createElement(TerminalSwitch, { label: 'Allow terminal' }))
    expect(markup()).toContain('aria-label="Allow terminal"')
    expect(markup()).toContain('aria-checked="false"')
    settings.terminal = true
    expect(markup()).toContain('aria-checked="true"')
  })

  it('sits after the Direct group while remote access is on', () => {
    remote.status = status()
    let section: ReturnType<typeof useRemoteSection> | null = null
    const Probe = () => {
      section = useRemoteSection()
      return null
    }
    renderToStaticMarkup(createElement(Probe))
    const ids = section!.rows.map((row) => row.id)
    expect(ids.slice(ids.indexOf('direct-own'))).toEqual(['direct-own', 'terminal', 'reset'])
    const row = section!.rows.find((entry) => entry.id === 'terminal')!
    expect([row.name, row.english]).toEqual(['Allow terminal', 'Allow terminal'])
    expect(renderToStaticMarkup(row.render('') as ReactElement)).toContain('aria-checked="false"')
    // Off, the page lists devices only.
    settings.enabled = false
    renderToStaticMarkup(createElement(Probe))
    expect(section!.rows.map((entry) => entry.id)).not.toContain('terminal')
  })

  it('says what devices can do with it, in English and in Chinese', async () => {
    const row = () => [
      i18n.t('settings:remote.terminal.name'),
      i18n.t('settings:remote.terminal.description'),
    ]
    expect(row()).toEqual([
      'Allow terminal',
      'Devices can run any command on this computer, beyond what an agent asks to run. Turning ' +
        "it off closes devices' terminals; the terminals keep running here.",
    ])
    await i18n.changeLanguage('zh-CN')
    expect(row()).toEqual([
      '允许终端',
      '设备能在这台电脑上运行任何命令，超出 Agent 要授权的范围。关掉时断开设备上的终端，终端本身继续运行。',
    ])
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
    expect(row).toBe('My iPhone iOS app · iPhone 17 Pro · iOS Online')
  })

  it('names the platform as people do, in either language', async () => {
    const line = (platform: string) => deviceLine(t(), { ...phone, platform })
    expect(line('ipados')).toBe('iOS app · iPhone 17 Pro · iPadOS')
    await i18n.changeLanguage('zh-CN')
    expect(line('ios')).toBe('iOS 应用 · iPhone 17 Pro · iOS')
    expect(deviceLine(t(), { kind: 'desktop', model: '', platform: 'darwin' })).toBe(
      '桌面应用 · macOS',
    )
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

describe('platform names', () => {
  it('read as people name them, and anything else as sent', () => {
    expect(
      ['ios', 'ipados', 'darwin', 'win32', 'linux', 'freebsd', 'iOS 26.1'].map(platformName),
    ).toEqual(['iOS', 'iPadOS', 'macOS', 'Windows', 'Linux', 'freebsd', 'iOS 26.1'])
  })
})

describe('the list', () => {
  it('without devices says how to add one', () => {
    expect(text(createElement(NoDevices))).toBe(
      'No devices yet Scan the code with Kettu on an iPhone or iPad, or paste the link in Settings › Hosts › Add host… in Kettu on another computer. Add device…',
    )
  })

  it('stays with remote access off, all offline, with only Add device waiting for it', () => {
    settings.enabled = false
    remote.status = status({ state: 'off', online: [], direct: { state: 'off' } })
    let section: ReturnType<typeof useRemoteSection> | null = null
    const Probe = () => {
      section = useRemoteSection()
      return null
    }
    renderToStaticMarkup(createElement(Probe))
    const rows = section!.rows
    expect(rows.map((row) => row.id)).toEqual(['remote', phone.id, 'add-device'])
    expect(text(rows[1]!.render('') as ReactElement)).toContain('Connected 3 days ago')
    expect(renderToStaticMarkup(rows[2]!.render('') as ReactElement)).toContain(
      '<button type="button" disabled=""',
    )
    expect(text(rows[1]!.group!.note as ReactElement)).toBe(
      'Turn on remote access to add a device.',
    )
    // With no device to show, the page is the switch alone.
    remote.status = status({ state: 'off', devices: [] })
    renderToStaticMarkup(createElement(Probe))
    expect(section!.rows.map((row) => row.id)).toEqual(['remote'])
  })

  it('opens Add device while remote access is on', () => {
    expect(renderToStaticMarkup(createElement(AddDeviceRow))).not.toContain('disabled=""')
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
    // Another computer pastes the link where it adds hosts.
    expect(body).toContain(
      'On another computer, open Settings › Hosts › Add host… in its Kettu and paste this link.',
    )
    expect(body).toContain(link)
    expect(body).toMatch(/expires in 4:3[12] ?\./)
  })

  it('offers a browser link for each address a browser can open', () => {
    const real = pairingLink({
      version: 1,
      hostKey: new Uint8Array(32).fill(1),
      secret: new Uint8Array(32).fill(2),
      addresses: [WIFI, { host: 'fd7a:115c::1', port: 47821 }],
    })
    const links = browserLinks(real, [])
    expect(links.map((l) => l.address)).toEqual(['192.168.1.8:47821', '[fd7a:115c::1]:47821'])
    // The owner's own addresses come after the ones this computer found.
    expect(browserLinks(real, [WIFI]).map((l) => l.address)).toEqual([
      '[fd7a:115c::1]:47821',
      '192.168.1.8:47821',
    ])
    expect(links[0]!.link).toMatch(/^http:\/\/192\.168\.1\.8:47821\/pair#/)
    expect(parseBrowserPairingLink(links[1]!.link)).toEqual(parsePairingLink(real))
    const body = text(
      createElement(CodeBody, { shown: { kind: 'pairing', pairing: waiting }, link: real }),
    )
    expect(body).toMatch(/^App Browser /)
    // A code without addresses has no browser link to offer.
    expect(browserLinks(link, [])).toEqual([])
    expect(
      text(createElement(CodeBody, { shown: { kind: 'pairing', pairing: waiting }, link })),
    ).not.toContain('Browser')
  })

  it.each([
    ['expired', 'Expired', 'This code has expired'],
    ['attempts', 'Too many tries', 'Too many tries, so this code is void'],
    ['rejected', 'Rejected', 'You rejected the device, so this code is void'],
    ['replaced', 'Opened elsewhere', 'Add device opened elsewhere, so this code is void'],
    ['stopped', 'Remote access stopped', 'Remote access stopped, so this code is void'],
  ] as const)('says why a code is void: %s', (reason, label, title) => {
    const shown = { kind: 'pairing' as const, pairing: { state: 'void' as const, reason } }
    const body = text(createElement(CodeBody, { shown, link }))
    // The QR code's overlay names the reason, then the text beside it says more.
    expect(body).toMatch(new RegExp(`^${label} ${title} `))
    expect(body).not.toContain('expires in')
    // The link stays, greyed out, and copies no more.
    expect(renderToStaticMarkup(createElement(CodeBody, { shown, link }))).toMatch(
      /text-disabled[^>]*>https:\/\/kettu\.sh\/pair#AQID/,
    )
  })

  it.each([
    ['expired', '已失效'],
    ['attempts', '试错太多次'],
    ['rejected', '已拒绝'],
    ['replaced', '已在别处打开'],
    ['stopped', '远程访问已停止'],
  ] as const)('names why a code is void in Chinese: %s', async (reason, label) => {
    await i18n.changeLanguage('zh-CN')
    const shown = { kind: 'pairing' as const, pairing: { state: 'void' as const, reason } }
    expect(text(createElement(CodeBody, { shown, link }))).toMatch(new RegExp(`^${label} `))
  })

  it('asks whether to add the device, with its name to edit', () => {
    const pairing = {
      state: 'confirm' as const,
      device: {
        name: 'Lin’s iPad',
        model: 'iPad Air',
        kind: 'ios',
        platform: 'ipados',
        known: false,
      },
    }
    const confirm = createElement(
      Dialog,
      null,
      createElement(Confirm, { pairing, onAnswer: () => {} }),
    )
    expect(renderToStaticMarkup(confirm)).toContain('value="Lin’s iPad"')
    const body = text(confirm)
    expect(body).toContain('Add this device?')
    // Its model and platform, as the device list shows them.
    expect(body).toContain('iOS app · iPad Air · iPadOS · Just connected with this code')
    expect(body).toMatch(/Reject Add$/)
  })

  it('asks in Chinese, and says when the device was added before', async () => {
    await i18n.changeLanguage('zh-CN')
    const device = { name: 'MacBook', model: 'MacBook Pro', kind: 'desktop', platform: 'darwin' }
    const confirm = (known: boolean) =>
      text(
        createElement(
          Dialog,
          null,
          createElement(Confirm, {
            pairing: { state: 'confirm', device: { ...device, known } },
            onAnswer: () => {},
          }),
        ),
      )
    expect(confirm(false)).toContain('桌面应用 · MacBook Pro · macOS · 刚用这个码连上')
    expect(confirm(true)).toContain('桌面应用 · MacBook Pro · macOS · 添加过，刚用这个码重新连上')
  })
})

describe('the question on Add device', () => {
  it('takes no click outside as an answer, and Esc or a close button as Reject', () => {
    expect(closeRequest(true, 'outside-press')).toBe('stay')
    expect(closeRequest(true, 'focus-out')).toBe('stay')
    expect(closeRequest(true, 'escape-key')).toBe('reject')
    expect(closeRequest(true, 'close-press')).toBe('reject')
    // Before the question and once it is answered, the dialog closes as any does.
    for (const reason of ['outside-press', 'escape-key', 'close-press'] as const) {
      expect(closeRequest(false, reason)).toBe('close')
    }
  })
})

describe("a device's page", () => {
  it('names a session in its activity by the title it had then', () => {
    const row = (event: DeviceActivity) => text(createElement(ActivityRow, { event, kind: 'ios' }))
    expect(
      row({ at: now, kind: 'session-archived', sessionId: 's1', title: 'Fix the login' }),
    ).toContain('Archived “Fix the login”')
    expect(row({ at: now, kind: 'session-deleted', sessionId: 's2', title: null })).toContain(
      'Deleted a session',
    )
  })

  it('names the project of a terminal it opened or closed, beside its sessions', async () => {
    const row = (event: DeviceActivity) => text(createElement(ActivityRow, { event, kind: 'ios' }))
    const opened: DeviceActivity = { at: now, kind: 'terminal-opened', projectPath: '/work/kettu' }
    const closed: DeviceActivity = { at: now, kind: 'terminal-closed', projectPath: '/work/kettu' }
    expect(row(opened)).toMatch(/ Opened a terminal kettu$/)
    expect(row(closed)).toMatch(/ Closed a terminal kettu$/)
    expect(
      row({ at: now, kind: 'session-created', sessionId: 's1', title: 'Fix the login' }),
    ).toContain('Started “Fix the login”')
    await i18n.changeLanguage('zh-CN')
    expect(row(opened)).toMatch(/ 打开终端 kettu$/)
    expect(row(closed)).toMatch(/ 关闭终端 kettu$/)
  })

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

  it('says what it runs, with the platform as people name it', () => {
    remote.status = status()
    expect(text(createElement(DevicePage, { id: phone.id }))).toContain(
      'iOS app · iPhone 17 Pro · iOS',
    )
  })

  it("words main's codes when it could not rename or remove the device", async () => {
    const failed = (code: 'not_renamed' | 'not_removed') => changeDevice(t(), async () => code)
    expect(await failed('not_renamed')).toBe('The device could not be renamed. Try again.')
    expect(await failed('not_removed')).toBe('The device could not be removed. Try again.')
    expect(await changeDevice(t(), async () => null)).toBeNull()
    // A call main refused outright still says why.
    expect(await changeDevice(t(), () => Promise.reject(new Error('Not a device id')))).toBe(
      'Not a device id',
    )
    await i18n.changeLanguage('zh-CN')
    expect(await failed('not_renamed')).toBe('没能给设备改名，再试一次。')
    expect(await failed('not_removed')).toBe('没能移除这台设备，再试一次。')
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
