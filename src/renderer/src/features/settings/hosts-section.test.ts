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
  isAway: (connection: { state: string }) =>
    connection.state !== 'online' && connection.state !== 'connecting',
}))
vi.mock('@renderer/lib/use-now', () => ({ useNow: () => Date.now(), useSeconds: () => Date.now() }))

const { i18n } = await import('@renderer/lib/i18n')
const { Dialog } = await import('@renderer/components/ui/dialog')
const { HostRow, HostsNote, SelfRow } = await import('./hosts-section')
const { AddHostBody, SshAddBody } = await import('./host-add')
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

const sshBox: HostStatus = {
  ...devBox,
  addresses: [],
  ssh: { target: 'lin@dev-box', port: 52001 },
  connection: { state: 'online', address: { host: '127.0.0.1', port: 52001 } },
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

describe('Add host over SSH', () => {
  const body = (step: Parameters<typeof SshAddBody>[0]['step'], draft = 'lin@dev-box') =>
    text(
      createElement(
        Dialog,
        { open: true },
        createElement(SshAddBody, {
          step,
          draft,
          target: 'lin@dev-box',
          onDraft: () => {},
          onSubmit: () => {},
          onRetry: () => {},
          onDone: () => {},
        }),
      ),
    )
  const failed = (reason: Parameters<typeof SshAddBody>[0]['step'] & { kind: 'failed' }) => reason

  it('asks for the address, and that Kettu keeps no key', async () => {
    expect(body({ kind: 'enter' }, '')).toBe(
      'Add host Kettu uses your own SSH config and agent, so jump hosts, ports and aliases work as usual. If Kettu is not on that machine yet, it is installed. Kettu never reads or stores your SSH keys. Cancel Connect',
    )
    const markup = renderToStaticMarkup(
      createElement(
        Dialog,
        { open: true },
        createElement(SshAddBody, {
          step: { kind: 'enter' },
          draft: '-oProxyCommand=x',
          target: '',
          onDraft: () => {},
          onSubmit: () => {},
          onRetry: () => {},
          onDone: () => {},
        }),
      ),
    )
    expect(markup).toContain('placeholder="lin@dev-box"')
    expect(markup).toMatch(/disabled=""[^>]*>Connect</)
    await i18n.changeLanguage('zh-CN')
    expect(body({ kind: 'enter' }, '')).toBe(
      '添加主机 用你自己的 SSH 配置和 agent，跳板机、端口和别名照常生效。那台机器上没装 Kettu 的，会自动装上。 Kettu 不读也不存你的 SSH 密钥。 取消 连接',
    )
  })

  it('shows each step, with installing or updating once it is needed', async () => {
    expect(body({ kind: 'working', steps: [{ step: 'connecting' }] })).toBe(
      'Add host Kettu uses your own SSH config and agent, so jump hosts, ports and aliases work as usual. If Kettu is not on that machine yet, it is installed. Log in over SSH Add this computer Open the encrypted channel Cancel',
    )
    const updating = body({
      kind: 'working',
      steps: [{ step: 'connecting' }, { step: 'updating', from: '0.2.0', to: '0.3.0' }],
    })
    expect(updating).toContain(
      'Log in over SSH done Update Kettu from 0.2.0 to 0.3.0 Add this computer Open the encrypted channel Cancel',
    )
    await i18n.changeLanguage('zh-CN')
    expect(
      body({
        kind: 'working',
        steps: [
          { step: 'connecting' },
          { step: 'installing', version: '0.3.0' },
          { step: 'adding' },
        ],
      }),
    ).toContain('经 SSH 登录 已完成 安装 Kettu 0.3.0 已完成 添加这台电脑 打开加密通道 取消')
  })

  it.each([
    ['ssh_auth', 'did not accept the login.', 'check that ssh lin@dev-box logs in without one'],
    ['ssh_host_unknown', "does not know lin@dev-box's host key yet.", 'ssh lin@dev-box'],
    ['ssh_host_changed', 'someone may be intercepting the connection', 'known hosts'],
    ['ssh_forwarding', 'does not forward connections', 'AllowTcpForwarding'],
    ['ssh_not_running', 'its daemon is not running', 'kettu service install'],
    ['ssh_missing', 'has no ssh program', 'OpenSSH client'],
    ['ssh_unsupported', 'has no POSIX shell', 'Apple silicon'],
    ['update_client', 'Kettu on this computer is too old for this host.', 'Update it'],
  ] as const)('says why it added nothing: %s', (reason, words, more) => {
    const shown = body(
      failed({ kind: 'failed', steps: [{ step: 'connecting' }], reason, detail: null }),
    )
    expect(shown).toContain(words)
    expect(shown).toContain(more)
    expect(shown).toContain('Log in over SSH failed')
    expect(shown).toMatch(/Close Retry$/)
  })

  it('names the system, and shows the last lines where they help', async () => {
    expect(
      body(
        failed({ kind: 'failed', steps: [], reason: 'ssh_unsupported', detail: 'FreeBSD amd64' }),
      ),
    ).toContain('Kettu has no daemon for FreeBSD amd64, which lin@dev-box runs.')
    const install = body(
      failed({
        kind: 'failed',
        steps: [{ step: 'connecting' }, { step: 'installing', version: '0.3.0' }],
        reason: 'ssh_install',
        detail: 'kettu install: Could not download it',
      }),
    )
    expect(install).toContain(
      'Log in over SSH done Install Kettu 0.3.0 failed Add this computer Open the encrypted channel',
    )
    expect(install).toContain(
      'Installing Kettu on lin@dev-box failed. kettu install: Could not download it Close Retry',
    )
    // What ssh said of a host key is the sentence's to say.
    expect(
      body(
        failed({ kind: 'failed', steps: [], reason: 'ssh_host_changed', detail: '@@@ WARNING' }),
      ),
    ).not.toContain('@@@')
    await i18n.changeLanguage('zh-CN')
    expect(body(failed({ kind: 'failed', steps: [], reason: 'ssh_auth', detail: null }))).toContain(
      'lin@dev-box 没有接受登录。',
    )
  })

  it('names the host it added as reached over SSH', async () => {
    expect(body({ kind: 'added', host: sshBox })).toContain(
      'Added dev-box Linux · Kettu 0.2.0 · SSH',
    )
    await i18n.changeLanguage('zh-CN')
    expect(body({ kind: 'added', host: sshBox })).toContain(
      '已添加 dev-box Linux · Kettu 0.2.0 · SSH',
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
    expect(page).toContain("dev-box's settings Agents, harnesses, usage, the terminal")
    expect(page).toContain("Open dev-box's settings")
    expect(page).toContain('Remove from this computer')
    expect(renderToStaticMarkup(createElement(HostPage, { id: devBox.id }))).toContain(
      'value="Lin MacBook"',
    )
    await i18n.changeLanguage('zh-CN')
    const zh = text(createElement(HostPage, { id: devBox.id }))
    expect(zh).toContain('怎么连 直连 192.168.1.42:51234')
    expect(zh).toContain('这台电脑在 dev-box 上 名字')
    expect(zh).toContain('打开 dev-box 的设置')
    expect(zh).toContain('从这台电脑移除')
  })

  it('says the host removed this computer, and offers to add it again', () => {
    hosts.status = status({
      hosts: [{ ...devBox, removed: true, connection: { state: 'stopped', reason: 'removed' } }],
    })
    const page = text(createElement(HostPage, { id: devBox.id }))
    expect(page).toContain('dev-box removed this computer')
    expect(page).toContain('Add again…')
    // A host it cannot reach has no settings to open.
    expect(renderToStaticMarkup(createElement(HostPage, { id: devBox.id }))).toMatch(
      /disabled=""[^>]*>Open dev-box&#x27;s settings/,
    )
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

  it('says a host added over SSH is reached through it, at its address', async () => {
    hosts.status = status({ hosts: [sshBox] })
    const page = text(createElement(HostPage, { id: devBox.id }))
    expect(page).toContain('Reached SSH SSH address lin@dev-box')
    expect(page).toContain('Kettu reaches dev-box with your own SSH config and agent')
    expect(page).not.toContain('Edit…')
    expect(text(createElement(HostRow, { host: sshBox }))).toBe(
      'dev-box Linux · Kettu 0.2.0 · SSH lin@dev-box Online',
    )
    await i18n.changeLanguage('zh-CN')
    expect(text(createElement(HostPage, { id: devBox.id }))).toContain(
      '怎么连 SSH SSH 地址 lin@dev-box',
    )
  })

  it('says when a host is no longer listed', () => {
    hosts.status = status({ hosts: [] })
    expect(text(createElement(HostPage, { id: devBox.id }))).toContain(
      'This host is no longer in the list.',
    )
  })
})
