// The web client's `window.kettu`: the host's settings and host-level actions forwarded as its
// owner's calls over a fake link, and what the page keeps of the host it connects to.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostAdminEvent, HostInfo, HostSettingsPart } from '@shared/remote/host-admin'
import { hostSettingsPart } from '@shared/remote/host-admin'
import type { RemoteStatus } from '@shared/remote/status'
import { DEFAULT_SETTINGS } from '@shared/settings'
import type { HostPathRequest } from './host-path-request'
import type { HostLink, LinkState } from './link'

const asked = vi.hoisted(() => ({ requests: [] as unknown[], answer: null as string | null }))
const toasts = vi.hoisted(() => [] as string[])

vi.mock('./host-path-request', () => ({
  askHostPath: async (request: HostPathRequest) => {
    asked.requests.push(request)
    if (asked.answer !== null) await request.commit?.(asked.answer)
    return asked.answer
  },
}))
vi.mock('@renderer/components/ui/toast', () => ({ toast: (text: string) => toasts.push(text) }))
vi.mock('@renderer/lib/i18n', () => ({
  i18n: { t: (key: string, values: object) => `${key} ${JSON.stringify(values)}` },
}))
vi.stubGlobal('window', { kettu: { hostPlatform: () => 'darwin' } })

const { pageAddress, webApi, webHost } = await import('./api')
const { WebSettings } = await import('./settings')
const { useWebHostStore } = await import('@renderer/stores/web-host')

const WELCOME = {
  type: 'welcome',
  protocol: 1,
  host: { name: 'Studio', platform: 'linux', version: '1.2.0' },
  features: [],
  role: 'owner',
  device: { id: 'b'.repeat(32), name: 'Firefox · Linux' },
  terminal: false,
  addresses: [],
} as const
const CONNECTED: LinkState = {
  kind: 'connected',
  welcome: { ...WELCOME, features: [], addresses: [] },
}

const INFO: HostInfo = {
  name: 'Kettu',
  version: '1.2.0',
  system: 'Ubuntu 24.04 x64',
  userDataPath: '/home/ana/.local/share/kettu',
  isPackaged: true,
  sharing: false,
  updates: false,
  remoteSwitch: false,
  remoteReset: false,
  thumbnails: false,
}

/** A link that records every call and answers each method with `answers[method]`. */
function fakeLink(answers: Record<string, unknown> = {}) {
  const calls: { method: string; params: unknown }[] = []
  const sent: unknown[] = []
  const admin = new Set<(event: HostAdminEvent) => void>()
  const states = new Set<(state: LinkState) => void>()
  const messages = new Set<(message: Record<string, unknown>) => void>()
  let state: LinkState = { kind: 'connecting' }
  let wakes = 0
  const link = {
    get state() {
      return state
    },
    request: async (method: string, params: unknown) => {
      calls.push({ method, params })
      return answers[method] ?? null
    },
    send: (message: unknown) => void sent.push(message),
    wake: () => void wakes++,
    onState: (listener: (state: LinkState) => void) => {
      states.add(listener)
      listener(state)
      return () => states.delete(listener)
    },
    onAdminEvent: (listener: (event: HostAdminEvent) => void) => {
      admin.add(listener)
      return () => admin.delete(listener)
    },
    onMessage: (listener: (message: Record<string, unknown>) => void) => {
      messages.add(listener)
      return () => messages.delete(listener)
    },
    onHostEvent: () => () => {},
    onTerminalEvent: () => () => {},
  }
  return {
    link: link as unknown as HostLink,
    calls,
    sent,
    wakes: () => wakes,
    setState(next: LinkState) {
      state = next
      for (const listener of states) listener(next)
    },
    emit(event: HostAdminEvent) {
      for (const listener of admin) listener(event)
    },
    message(message: Record<string, unknown>) {
      for (const listener of messages) listener(message)
    },
  }
}

function setup(answers: Record<string, unknown> = {}) {
  const fake = fakeLink({ 'host.info': INFO, ...answers })
  const settings = new WebSettings(null)
  settings.attach(fake.link)
  const forget = vi.fn(async () => {})
  const api = webApi(fake.link, settings, {
    address: { host: '192.168.1.8', port: 47821 },
    known: { name: 'Studio', deviceName: 'Firefox · Linux' },
    forget,
    storage: null,
  })
  return { ...fake, api, settings, forget }
}

beforeEach(() => {
  asked.requests.length = 0
  asked.answer = null
  toasts.length = 0
  useWebHostStore.setState({ host: null, info: null, actions: null })
})

describe('webApi', () => {
  it("forwards remote access, sharing, updates and agents to the host's calls", async () => {
    const { api, calls } = setup({ 'settings.addAgent': 'codex~work' })
    await api.remote.status()
    await expect(api.remote.closePairing(3)).resolves.toBeUndefined()
    await api.remote.answerPairing(3, true, 'iPad')
    await api.sharing.publish('a1', 2)
    await api.updates.getStatus()
    await expect(api.settings.addAgent('codex', 'Work', '/home/ana/.codex-work')).resolves.toBe(
      'codex~work',
    )
    await api.settings.removeAgent('codex~work', true)
    expect(calls).toEqual([
      { method: 'remote.status', params: undefined },
      { method: 'remote.closePairing', params: { codeId: 3 } },
      { method: 'remote.answerPairing', params: { codeId: 3, add: true, name: 'iPad' } },
      { method: 'sharing.publish', params: { id: 'a1', version: 2 } },
      { method: 'updates.status', params: undefined },
      {
        method: 'settings.addAgent',
        params: { harnessId: 'codex', name: 'Work', folder: '/home/ana/.codex-work' },
      },
      { method: 'settings.removeAgent', params: { agentId: 'codex~work', trash: true } },
    ])
  })

  it("hears only its own kind of the host's events", () => {
    const { api, emit } = setup()
    const statuses: RemoteStatus[] = []
    const pairings: unknown[] = []
    api.remote.onChanged((status) => statuses.push(status))
    api.remote.onPairing((event) => pairings.push(event))
    const status = { state: 'on' } as RemoteStatus
    emit({ type: 'remote.changed', status })
    emit({
      type: 'remote.pairing',
      event: { codeId: 1, pairing: { state: 'void', reason: 'closed' } },
    })
    emit({ type: 'updates.changed', status: { current: '1.2.0' } as never })
    expect(statuses).toEqual([status])
    expect(pairings).toEqual([{ codeId: 1, pairing: { state: 'void', reason: 'closed' } }])
  })

  it('restarts the agent and terminal hosts on the host, and connects again at once', async () => {
    const { api, calls, wakes } = setup()
    await api.agents.restart()
    await api.terminals.restart()
    expect(calls).toEqual([
      { method: 'host.restart', params: { process: 'agent' } },
      { method: 'host.restart', params: { process: 'terminal' } },
    ])
    expect(wakes()).toBe(2)
  })

  it("answers the app's facts with the host's, read again at each connection", async () => {
    const { api, calls, setState } = setup()
    setState(CONNECTED)
    expect(await api.app.getInfo()).toEqual(INFO)
    expect(await api.app.getInfo()).toEqual(INFO)
    expect(calls.filter((c) => c.method === 'host.info')).toHaveLength(1)
    expect(useWebHostStore.getState().info).toEqual(INFO)
    setState({ kind: 'reconnecting', reason: null })
    setState(CONNECTED)
    expect(calls.filter((c) => c.method === 'host.info')).toHaveLength(2)
  })

  it('chooses a shell on the host and takes the settings the host answers with', async () => {
    const part: HostSettingsPart = hostSettingsPart({
      ...DEFAULT_SETTINGS,
      terminal: { fontSize: 13, shellPath: '/usr/bin/fish' },
    })
    const { api, calls, settings } = setup({ 'settings.setShellPath': part })
    asked.answer = '/usr/bin/fish'
    await expect(api.dialogs.chooseShell()).resolves.toBe('/usr/bin/fish')
    expect(asked.requests).toEqual([expect.objectContaining({ purpose: 'shell', initial: '~/' })])
    expect(calls.at(-1)).toEqual({
      method: 'settings.setShellPath',
      params: { path: '/usr/bin/fish' },
    })
    expect(settings.current().terminal.shellPath).toBe('/usr/bin/fish')
  })

  it("starts a program's picker beside the program chosen before", async () => {
    const { api, settings } = setup()
    settings.takeHost(
      hostSettingsPart({
        ...DEFAULT_SETTINGS,
        agents: { codex: { binaryPath: '/opt/bin/codex' } },
      }),
    )
    await expect(api.dialogs.chooseAgentBinary('codex')).resolves.toBeNull()
    expect(asked.requests).toEqual([
      expect.objectContaining({ purpose: 'agentProgram', initial: '/opt/bin/' }),
    ])
  })

  it('returns a chosen folder for the caller to add, asking nothing of the host', async () => {
    const { api, calls } = setup()
    asked.answer = '/home/ana/.claude-work'
    await expect(api.dialogs.chooseAgentFolder()).resolves.toBe('/home/ana/.claude-work')
    expect(calls).toEqual([])
  })

  it('copies a path it cannot show and says so', async () => {
    const written: string[] = []
    vi.stubGlobal('navigator', {
      userAgent: navigator.userAgent,
      languages: navigator.languages,
      clipboard: { writeText: async (text: string) => void written.push(text) },
    })
    try {
      const { api } = setup()
      await api.shell.showItem('/home/ana/notes.md')
      await api.shell.showDataFolder()
      expect(written).toEqual(['/home/ana/notes.md', INFO.userDataPath])
      expect(toasts).toHaveLength(2)
      expect(toasts[0]).toContain('web:copiedPath')
    } finally {
      vi.unstubAllGlobals()
      vi.stubGlobal('window', { kettu: { hostPlatform: () => 'darwin' } })
    }
  })

  it('keeps the host as Settings shows it, and renames this browser through the channel', async () => {
    const { setState, message, sent, forget } = setup()
    expect(useWebHostStore.getState().host).toMatchObject({
      name: 'Studio',
      platform: null,
      connection: { state: 'connecting' },
      device: { id: null, name: 'Firefox · Linux' },
    })
    setState(CONNECTED)
    expect(useWebHostStore.getState().host).toMatchObject({
      platform: 'linux',
      version: '1.2.0',
      connection: { state: 'online', address: { host: '192.168.1.8', port: 47821 } },
      device: { id: 'b'.repeat(32) },
    })
    const { actions } = useWebHostStore.getState()
    actions?.rename('Work laptop')
    expect(sent).toEqual([{ type: 'rename', name: 'Work laptop' }])
    message({ type: 'renamed', name: 'Work laptop' })
    expect(useWebHostStore.getState().host?.device.name).toBe('Work laptop')
    await actions?.forget()
    expect(forget).toHaveBeenCalledOnce()
  })
})

describe('webHost', () => {
  const start = {
    name: 'Studio',
    platform: null,
    version: null,
    address: { host: 'studio.local', port: 443 },
    connection: { state: 'connecting' },
    lastOnlineAt: null,
    device: { id: null, name: 'Safari · iPhone' },
  } as const

  it('goes offline since the connection ended, and stays stopped with the reason', () => {
    const online = webHost(start, CONNECTED, 100)
    expect(online.lastOnlineAt).toBe(100)
    const offline = webHost(online, { kind: 'reconnecting', reason: null }, 250)
    expect(offline.connection).toEqual({ state: 'offline' })
    expect(offline.lastOnlineAt).toBe(250)
    // Still offline later, it was last online at the same time.
    expect(webHost(offline, { kind: 'reconnecting', reason: null }, 900).lastOnlineAt).toBe(250)
    expect(webHost(offline, { kind: 'stopped', reason: 'update_host' }, 950).connection).toEqual({
      state: 'stopped',
      reason: 'update_host',
    })
  })
})

describe('pageAddress', () => {
  it("is the page's host and port, with the scheme's port when it names none", () => {
    expect(pageAddress({ hostname: '192.168.1.8', port: '47821', protocol: 'http:' })).toEqual({
      host: '192.168.1.8',
      port: 47821,
    })
    expect(pageAddress({ hostname: 'studio.tail.ts.net', port: '', protocol: 'https:' })).toEqual({
      host: 'studio.tail.ts.net',
      port: 443,
    })
    expect(pageAddress({ hostname: '[::1]', port: '', protocol: 'http:' })).toEqual({
      host: '::1',
      port: 80,
    })
  })
})
