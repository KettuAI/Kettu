// Settings › Hosts in each state it shows, in English and Chinese, rendered to markup.

import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostStatus, HostsStatus } from '@shared/remote/hosts'

vi.stubGlobal('window', {
  kettu: { platform: 'darwin' },
  matchMedia: () => ({ matches: false, addEventListener: () => {} }),
})
// Server rendering reads no store and no clock, so the test hands them over.
const hosts = vi.hoisted(() => ({ status: null as HostsStatus | null }))
vi.mock('@renderer/stores/hosts', () => ({
  useHostsStore: (select: (state: { status: HostsStatus | null }) => unknown) =>
    select({ status: hosts.status }),
  loadHosts: async () => {},
}))
vi.mock('@renderer/lib/use-now', () => ({ useNow: () => Date.now(), useSeconds: () => Date.now() }))

const { i18n } = await import('@renderer/lib/i18n')
const { Dialog } = await import('@renderer/components/ui/dialog')
const { HostRow, HostsNote, SelfRow } = await import('./hosts-section')
const { AddHostBody } = await import('./host-add')
const { HostPage } = await import('./host-page')
const { changeHost } = await import('./host-text')

const HOUR = 60 * 60 * 1000
const now = Date.now()
const LAN = { host: '192.168.1.42', port: 51234 }

const devBox: HostStatus = {
  id: 'a'.repeat(32),
  publicKey: 'key',
  name: 'dev-box',
  platform: 'linux',
  version: '0.2.0',
  addresses: [LAN, { host: 'dev.example.com', port: 7000 }],
  deviceName: 'Lin MacBook',
  addedAt: new Date(2026, 9, 31).getTime(),
  lastOnlineAt: now - 2 * HOUR,
  removed: false,
  connection: { state: 'online', address: LAN },
}

const self: HostsStatus['self'] = {
  name: 'Lin MacBook',
  platform: 'darwin',
  version: '0.3.0',
  model: 'MacBook Pro',
}

function status(patch: Partial<HostsStatus> = {}): HostsStatus {
  return { self, hosts: [devBox], plainTextKey: false, keyFailed: false, ...patch }
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
  hosts.status = null
  await i18n.changeLanguage('en')
})

describe('the list', () => {
  it('puts this computer first, with its system and version', async () => {
    expect(text(createElement(SelfRow, { self }))).toBe(
      'Lin MacBook Local macOS · Kettu 0.3.0 This computer',
    )
    expect(renderToStaticMarkup(createElement(SelfRow, { self }))).toContain('lucide-laptop')
    await i18n.changeLanguage('zh-CN')
    expect(text(createElement(SelfRow, { self }))).toBe(
      'Lin MacBook 本机 macOS · Kettu 0.3.0 这台电脑',
    )
  })

  it('says how each host is reached and whether it is online', async () => {
    expect(text(createElement(HostRow, { host: devBox }))).toBe(
      'dev-box Linux · Kettu 0.2.0 · Direct 192.168.1.42:51234 Online',
    )
    const offline: HostStatus = { ...devBox, connection: { state: 'offline' } }
    expect(text(createElement(HostRow, { host: offline }))).toBe(
      'dev-box Linux · Kettu 0.2.0 · Direct Offline · 2 hours ago',
    )
    const connecting: HostStatus = { ...devBox, connection: { state: 'connecting' } }
    expect(text(createElement(HostRow, { host: connecting }))).toContain('Connecting…')
    const removed: HostStatus = {
      ...devBox,
      removed: true,
      connection: { state: 'stopped', reason: 'removed' },
    }
    expect(text(createElement(HostRow, { host: removed }))).toContain('Removed')
    await i18n.changeLanguage('zh-CN')
    expect(text(createElement(HostRow, { host: devBox }))).toBe(
      'dev-box Linux · Kettu 0.2.0 · 直连 192.168.1.42:51234 在线',
    )
    expect(text(createElement(HostRow, { host: offline }))).toBe(
      'dev-box Linux · Kettu 0.2.0 · 直连 离线 · 2 小时前',
    )
  })

  it('says where devices connect to this computer, and how the key is kept', async () => {
    hosts.status = status()
    expect(text(createElement(HostsNote))).toBe(
      'To connect to this computer from a phone or another computer, add the device in Remote access.',
    )
    hosts.status = status({ plainTextKey: true })
    expect(text(createElement(HostsNote))).toContain(
      'is kept in a file only you can read, because the system has no keyring.',
    )
    hosts.status = status({ keyFailed: true })
    await i18n.changeLanguage('zh-CN')
    expect(text(createElement(HostsNote))).toContain(
      '系统没能解开这台电脑连别的主机用的密钥，所以连不了别的主机。',
    )
    expect(text(createElement(HostsNote))).toContain('到 远程访问 里添加设备。')
  })
})

describe('Add host', () => {
  const link = 'https://kettu.sh/pair#AQID'
  const body = (step: Parameters<typeof AddHostBody>[0]['step'], draft = '') =>
    text(
      createElement(
        Dialog,
        { open: true },
        createElement(AddHostBody, {
          step,
          draft,
          link,
          onDraft: () => {},
          onSubmit: () => {},
          onRetry: () => {},
          onAgain: () => {},
          onDone: () => {},
        }),
      ),
    )

  it('asks for the link, and says what is wrong with one that is none', async () => {
    expect(body({ kind: 'paste', invalid: false })).toBe(
      'Add host In Kettu on that host, open Settings › Remote access › Add device, or run kettu pair on a development machine, and paste the link it shows here. Cancel Add',
    )
    expect(body({ kind: 'paste', invalid: true }, 'https://kettu.sh/pair#AT3k')).toContain(
      'This is not a Kettu pairing link, or it was not copied whole.',
    )
    await i18n.changeLanguage('zh-CN')
    expect(body({ kind: 'paste', invalid: false })).toBe(
      '添加主机 在那台主机的 Kettu 里打开 设置 › 远程访问 › 添加设备，或在开发机上运行 kettu pair ，把显示的链接粘贴到这里。 取消 添加',
    )
  })

  it('connects, then waits for the host', async () => {
    expect(body({ kind: 'connecting' })).toContain('Connecting… Cancel')
    expect(body({ kind: 'confirm' })).toContain(
      'Confirm on that host Connected, and waiting for Add on the host.',
    )
    await i18n.changeLanguage('zh-CN')
    expect(body({ kind: 'confirm' })).toContain('在那台主机上确认')
    expect(body({ kind: 'confirm' })).toContain('等主机确认… 取消')
  })

  it.each([
    ['void', 'This pairing code no longer works', 'Paste a new link'],
    ['rejected', 'The host did not add this computer.', 'Paste a new link'],
    ['unreachable', 'Could not reach the host within 15 seconds.', 'Retry'],
    ['self', "This is this computer's own pairing code.", 'Paste a new link'],
    ['update_host', 'Kettu on the host is too old for this computer.', 'Paste a new link'],
  ] as const)('says why it added nothing: %s', (reason, words, action) => {
    const shown = body({ kind: 'failed', reason })
    expect(shown).toContain(words)
    expect(shown).toMatch(new RegExp(`Close ${action}$`))
  })

  it('names the host it added and this computer there, in Chinese too', async () => {
    expect(body({ kind: 'added', host: devBox })).toBe(
      "Add host Added dev-box Linux · Kettu 0.2.0 · Direct This computer's name on dev-box dev-box lists this computer under this name; change it later in Settings › Hosts › dev-box. Done",
    )
    await i18n.changeLanguage('zh-CN')
    expect(body({ kind: 'added', host: devBox })).toBe(
      '添加主机 已添加 dev-box Linux · Kettu 0.2.0 · 直连 这台电脑在 dev-box 上的名字 dev-box 的设备列表里显示这个名字，以后在 设置 › 主机 › dev-box 里改。 完成',
    )
  })
})

describe("a host's page", () => {
  it('says whether it is online, how it is reached and what this computer is called there', async () => {
    hosts.status = status()
    const page = text(createElement(HostPage, { id: devBox.id }))
    expect(page).toContain('dev-box Online Linux · Kettu 0.2.0 · Added Oct 31')
    expect(page).toContain('Reached Direct 192.168.1.42:51234')
    expect(page).toContain('Addresses 192.168.1.42:51234 dev.example.com:7000 Edit…')
    expect(page).toContain('This computer on dev-box Name dev-box lists this computer under')
    expect(page).toContain('Remove from this computer')
    expect(renderToStaticMarkup(createElement(HostPage, { id: devBox.id }))).toContain(
      'value="Lin MacBook"',
    )
    await i18n.changeLanguage('zh-CN')
    const zh = text(createElement(HostPage, { id: devBox.id }))
    expect(zh).toContain('怎么连 直连 192.168.1.42:51234')
    expect(zh).toContain('这台电脑在 dev-box 上 名字')
    expect(zh).toContain('从这台电脑移除')
  })

  it('says the host removed this computer, and offers to add it again', () => {
    hosts.status = status({
      hosts: [{ ...devBox, removed: true, connection: { state: 'stopped', reason: 'removed' } }],
    })
    const page = text(createElement(HostPage, { id: devBox.id }))
    expect(page).toContain('dev-box removed this computer')
    expect(page).toContain('Add again…')
    // Its name can be changed only while it is online.
    expect(renderToStaticMarkup(createElement(HostPage, { id: devBox.id }))).toMatch(
      /disabled=""[^>]*value="Lin MacBook"|value="Lin MacBook"[^>]*disabled=""/,
    )
  })

  it("words main's codes when a change to a host fails", async () => {
    const t = i18n.getFixedT(null, 'settings')
    const failed = (code: 'not_connected' | 'unknown_host') =>
      changeHost(t, devBox, async () => code)
    expect(await failed('not_connected')).toBe(
      'dev-box is not connected. Try again once it is online.',
    )
    expect(await failed('unknown_host')).toBe("dev-box is no longer in this computer's list.")
    expect(await changeHost(t, devBox, async () => null)).toBeNull()
    // A call main refused outright still says why.
    expect(await changeHost(t, devBox, () => Promise.reject(new Error('Not a host id')))).toBe(
      'Not a host id',
    )
    await i18n.changeLanguage('zh-CN')
    const zh = i18n.getFixedT(null, 'settings')
    expect(await changeHost(zh, devBox, async () => 'not_connected')).toBe(
      'dev-box 没有连上，等它在线后再试。',
    )
    expect(await changeHost(zh, devBox, async () => 'unknown_host')).toBe(
      '这台电脑的列表里已经没有 dev-box 了。',
    )
  })

  it('says when a host is no longer listed', () => {
    hosts.status = status({ hosts: [] })
    expect(text(createElement(HostPage, { id: devBox.id }))).toContain(
      'This host is no longer in the list.',
    )
  })
})
