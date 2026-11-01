// The web client's settings: the host's part read from and written to the host over a fake link,
// the rest kept in a fake localStorage.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { hostSettingsPart, type HostAdminEvent } from '@shared/remote/host-admin'
import { DEFAULT_SETTINGS, type SettingsFile } from '@shared/settings'
import type { LinkState } from './link'
import { WebSettings, type SettingsLink } from './settings'

const KEY = 'kettu.settings'

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial))
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  }
}

/** The host's settings file, with its part changed from the defaults so it can be told apart. */
const HOST_FILE: SettingsFile = {
  ...DEFAULT_SETTINGS,
  general: { ...DEFAULT_SETTINGS.general, sessionTitles: false, language: 'zh-CN' },
  terminal: { shellPath: '/bin/zsh', fontSize: 14 },
  remote: { ...DEFAULT_SETTINGS.remote, enabled: true, terminal: true },
  usage: { fromComputer: true, sidebar: 'cost' },
}
const HOST_PART = hostSettingsPart(HOST_FILE)

const CONNECTED: LinkState = {
  kind: 'connected',
  welcome: {
    type: 'welcome',
    protocol: 1,
    host: { name: 'Studio', platform: 'darwin', version: '1.0.0' },
    features: [],
    role: 'owner',
    device: { id: 'a'.repeat(32), name: 'Safari · Mac' },
    terminal: true,
    addresses: [],
  },
}

/** A link the test drives: it answers requests with `answer`, and states and events on demand. */
function fakeLink(answer: (method: string, params: unknown) => Promise<unknown>) {
  const events = new Set<(event: HostAdminEvent) => void>()
  const states = new Set<(state: LinkState) => void>()
  let state: LinkState = { kind: 'connecting' }
  const requests: { method: string; params: unknown }[] = []
  const link: SettingsLink = {
    request: (method, params) => {
      requests.push({ method, params })
      return answer(method, params)
    },
    onAdminEvent: (listener) => {
      events.add(listener)
      return () => events.delete(listener)
    },
    onState: (listener) => {
      states.add(listener)
      listener(state)
      return () => states.delete(listener)
    },
  }
  return {
    link,
    requests,
    setState(next: LinkState) {
      state = next
      for (const listener of states) listener(next)
    },
    emit(event: HostAdminEvent) {
      for (const listener of events) listener(event)
    },
  }
}

const answering = (part = HOST_PART) =>
  fakeLink(async (method) => {
    if (method === 'settings.get') return part
    throw new Error(`Unexpected ${method}`)
  })

afterEach(() => {
  vi.useRealTimers()
})

describe('WebSettings', () => {
  it("keeps every row of this browser's own in its storage, without asking the host", async () => {
    const storage = memoryStorage()
    const settings = new WebSettings(storage)
    const fake = answering()
    settings.attach(fake.link)
    const file = await settings.update({
      general: { language: 'zh-CN', confirmQuitWhileRunning: false },
      notifications: { sound: true },
      privacy: { hideAccount: true },
      terminal: { fontSize: 12 },
      usage: { sidebar: 'off' },
    })
    expect(fake.requests).toEqual([])
    expect(file.general.language).toBe('zh-CN')
    expect(file.notifications.sound).toBe(true)
    const stored = JSON.parse(storage.items.get(KEY)!) as Record<string, Record<string, unknown>>
    expect(stored.general).toMatchObject({ language: 'zh-CN', confirmQuitWhileRunning: false })
    expect(stored.notifications?.sound).toBe(true)
    expect(stored.privacy).toEqual({ hideAccount: true })
    expect(stored.terminal).toEqual({ fontSize: 12 })
    expect(stored.usage).toEqual({ sidebar: 'off' })
    // The host's rows are never stored here.
    expect(Object.keys(stored)).not.toContain('remote')
    expect(stored.general).not.toHaveProperty('sessionTitles')
    expect(new WebSettings(storage).current().privacy.hideAccount).toBe(true)
  })

  it("reads the host's part once connected and lays it over this browser's", async () => {
    const storage = memoryStorage({ [KEY]: JSON.stringify({ general: { language: 'en' } }) })
    const settings = new WebSettings(storage)
    const fake = answering()
    settings.attach(fake.link)
    const read = settings.get()
    fake.setState(CONNECTED)
    const file = await read
    expect(fake.requests).toEqual([{ method: 'settings.get', params: undefined }])
    // The browser's language, the host's titles, shell and remote access.
    expect(file.general.language).toBe('en')
    expect(file.general.sessionTitles).toBe(false)
    expect(file.terminal).toEqual({ fontSize: 13, shellPath: '/bin/zsh' })
    expect(file.remote.enabled).toBe(true)
    expect(file.usage).toEqual({ fromComputer: true, sidebar: 'today' })
  })

  it('answers the first read with what it has when the host is slow, and tells the rest later', async () => {
    vi.useFakeTimers()
    const settings = new WebSettings(memoryStorage(), 1000)
    let resolve: (part: unknown) => void = () => {}
    const fake = fakeLink(() => new Promise((done) => (resolve = done)))
    settings.attach(fake.link)
    fake.setState(CONNECTED)
    const read = settings.get()
    await vi.advanceTimersByTimeAsync(1000)
    expect((await read).remote.enabled).toBe(false)
    const changed: SettingsFile[] = []
    settings.onChanged((file) => changed.push(file))
    resolve(HOST_PART)
    await vi.runAllTimersAsync()
    expect(changed.map((file) => file.remote.enabled)).toEqual([true])
    // Later reads no longer wait.
    expect((await settings.get()).remote.enabled).toBe(true)
  })

  it('does not wait before a link is attached, as on the pairing page', async () => {
    const settings = new WebSettings(memoryStorage(), 60_000)
    expect(await settings.get()).toEqual(DEFAULT_SETTINGS)
  })

  it("follows the host's events, and reads again after reconnecting", async () => {
    const settings = new WebSettings(memoryStorage())
    const fake = answering()
    settings.attach(fake.link)
    fake.setState(CONNECTED)
    await settings.get()
    const changed: SettingsFile[] = []
    settings.onChanged((file) => changed.push(file))
    fake.emit({
      type: 'settings.changed',
      settings: { ...HOST_PART, git: { backgroundFetch: true } },
    })
    expect(changed.at(-1)?.git.backgroundFetch).toBe(true)
    // The same part again changes nothing.
    fake.emit({
      type: 'settings.changed',
      settings: { ...HOST_PART, git: { backgroundFetch: true } },
    })
    expect(changed).toHaveLength(1)
    fake.setState({ kind: 'reconnecting', reason: null, kept: false })
    fake.setState(CONNECTED)
    await vi.waitFor(() => expect(changed).toHaveLength(2))
    expect(fake.requests.filter((r) => r.method === 'settings.get')).toHaveLength(2)
    expect(changed.at(-1)?.git.backgroundFetch).toBe(false)
  })

  it("writes the host's rows there, and this browser's here once the host took its part", async () => {
    const storage = memoryStorage()
    const settings = new WebSettings(storage)
    const written = { ...HOST_PART, remote: { ...HOST_PART.remote, terminal: false } }
    const fake = fakeLink(async (method) => {
      if (method === 'settings.get') return HOST_PART
      if (method === 'settings.update') return written
      throw new Error(`Unexpected ${method}`)
    })
    settings.attach(fake.link)
    fake.setState(CONNECTED)
    await settings.get()
    const changed: SettingsFile[] = []
    settings.onChanged((file) => changed.push(file))
    const file = await settings.update({
      remote: { terminal: false },
      general: { sessionTitles: true, sendKey: 'mod-enter' },
    })
    expect(fake.requests.at(-1)).toEqual({
      method: 'settings.update',
      params: { patch: { remote: { terminal: false }, general: { sessionTitles: true } } },
    })
    expect(file.remote.terminal).toBe(false)
    expect(file.general.sendKey).toBe('mod-enter')
    expect(changed).toEqual([file])
    expect(JSON.parse(storage.items.get(KEY)!)).toMatchObject({ general: { sendKey: 'mod-enter' } })
  })

  it("leaves this browser's part as it was when the host refuses its own", async () => {
    const storage = memoryStorage()
    const settings = new WebSettings(storage)
    const refusal = { name: 'PortRequestError', code: 'invalid_params', message: 'No' }
    const fake = fakeLink(async (method) => {
      if (method === 'settings.get') return HOST_PART
      throw refusal
    })
    settings.attach(fake.link)
    fake.setState(CONNECTED)
    await settings.get()
    const changed: SettingsFile[] = []
    settings.onChanged((file) => changed.push(file))
    await expect(
      settings.update({ proxy: { mode: 'environment' }, appearance: { textSize: 'large' } }),
    ).rejects.toBe(refusal)
    expect(settings.current().appearance.textSize).toBe('default')
    expect(storage.items.has(KEY)).toBe(false)
    expect(changed).toEqual([])
  })

  it("refuses the host's rows before a link is attached", async () => {
    const settings = new WebSettings(memoryStorage())
    await expect(settings.update({ git: { backgroundFetch: true } })).rejects.toThrow()
    expect(settings.current().git.backgroundFetch).toBe(false)
  })

  it("takes the host's part a call answered with, as after choosing a shell there", async () => {
    const settings = new WebSettings(memoryStorage())
    const changed: SettingsFile[] = []
    settings.onChanged((file) => changed.push(file))
    settings.takeHost(HOST_PART)
    expect(changed.at(-1)?.terminal.shellPath).toBe('/bin/zsh')
  })

  it('drops what an older build stored of the host, and values of the wrong type', () => {
    const storage = memoryStorage({
      [KEY]: JSON.stringify({
        general: { sessionTitles: false, language: 'zh-CN', restoreLastSession: 'yes' },
        remote: { enabled: true },
        appearance: { textSize: 'large', unknown: 1 },
      }),
    })
    const file = new WebSettings(storage).current()
    expect(file.general.sessionTitles).toBe(true)
    expect(file.general.language).toBe('zh-CN')
    expect(file.general.restoreLastSession).toBe(true)
    expect(file.remote.enabled).toBe(false)
    expect(file.appearance.textSize).toBe('large')
    expect(file.appearance).not.toHaveProperty('unknown')
  })
})
