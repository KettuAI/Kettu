import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostAdminEvent } from '@shared/remote/host-admin'
import type { PairingState } from '@shared/remote/pairing'
import type { RemoteStatus } from '@shared/remote/status'
import type { UpdateStatus } from '@shared/updates'
import { AgentFolders } from './agent-folders'
import { HostAdmin, type AdminRemote, type AdminUpdates, type HostAdminDeps } from './host-admin'
import { SettingsStore } from './settings'
import { CATALOG_URL, ThemeCatalog } from './theme-catalog'
import { ThemeStore } from './themes'

const PHONE = 'a'.repeat(32)
const TABLET = 'b'.repeat(32)
const posixIt = it.skipIf(process.platform === 'win32')

let dir: string
let settings: SettingsStore
// What the theme catalog's fake fetch answers, by path under CATALOG_URL.
let served: Record<string, string> = {}

beforeEach(async () => {
  dir = await mkdtemp(join(os.tmpdir(), 'kettu-host-admin-'))
  settings = await SettingsStore.load(dir)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(async () => {
  await settings.flush()
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

function status(online: string[]): RemoteStatus {
  return {
    state: 'on',
    hostName: 'Studio',
    systemName: 'studio',
    devices: [],
    online,
    plainTextKey: false,
    direct: { state: 'off' },
  }
}

function setup(overrides: Partial<HostAdminDeps> = {}) {
  const sent: { event: HostAdminEvent; deviceId: string | null }[] = []
  const restarted: string[] = []
  const closed: number[] = []
  const answered: [number, boolean, string][] = []
  const listeners = new Map<number, (pairing: PairingState) => void>()
  let nextCode = 1
  const remote: AdminRemote = {
    pair: (listener) => {
      const codeId = nextCode++
      listeners.set(codeId, listener)
      return codeId
    },
    closePairing: (codeId) => void closed.push(codeId),
    answerPairing: (codeId, add, name) => void answered.push([codeId, add, name]),
    renameDevice: async (id) => id === PHONE,
    removeDevice: async (id) => id === PHONE,
    activity: async () => [],
    reset: async () => {},
    retryDirect: () => {},
  }
  const trashed: string[] = []
  const hostSelect = vi.fn<(id: string) => void>()
  const themes: ThemeStore = new ThemeStore(
    { installed: [], failed: new Map() },
    new Map(),
    'kettu',
    {
      dir: join(dir, 'themes'),
      sourcesFile: join(dir, 'theme-sources.json'),
      catalog: new ThemeCatalog(async (url) => {
        const body = served[url.slice(CATALOG_URL.length)]
        return body === undefined ? new Response(null, { status: 404 }) : new Response(body)
      }),
      select: hostSelect,
      changed: () => admin.themesChanged(themes.hostThemes()),
    },
  )
  const agentFolders = new AgentFolders(settings, join(dir, 'agent-config'), async (folder) => {
    trashed.push(folder)
  })
  const admin = new HostAdmin({
    settings,
    agentFolders,
    platform: process.platform,
    remote,
    remoteStatus: () => status([PHONE]),
    info: async () => ({
      name: 'Kettu',
      version: '1.2.3',
      system: 'macOS 26.1 (arm64)',
      userDataPath: dir,
      isPackaged: true,
      sharing: true,
      updates: false,
      remoteSwitch: true,
      remoteReset: true,
      thumbnails: true,
    }),
    restart: (which) => void restarted.push(which),
    sharing: null,
    updates: null,
    themes,
    thumbnail: null,
    send: (event, deviceId) => void sent.push({ event, deviceId }),
    ...overrides,
  })
  settings.onChange((next) => admin.settingsChanged(next))
  const call = (method: string, params?: unknown, deviceId = PHONE) =>
    admin.answer(deviceId, method, params)
  return { admin, call, sent, restarted, closed, answered, listeners, trashed, hostSelect }
}

describe("HostAdmin's settings", () => {
  it("answers the host's part of the settings and none of a client's", async () => {
    const { call } = setup()
    settings.update({ general: { sendKey: 'mod-enter', sessionTitles: false } })
    const answer = await call('settings.get')
    expect(answer).toMatchObject({ result: { general: { sessionTitles: false } } })
    const part = (answer as { result: Record<string, unknown> }).result
    expect(part).not.toHaveProperty('appearance')
    expect(part.general).toEqual({ sessionTitles: false })
  })

  it("refuses a patch that sets a client's keys, and changes nothing of it", async () => {
    const { call, sent } = setup()
    const answer = await call('settings.update', {
      patch: { git: { backgroundFetch: true }, general: { sendKey: 'mod-enter' } },
    })
    expect(answer).toMatchObject({ error: { code: 'invalid_params' } })
    expect((answer as { error: { message: string } }).error.message).toContain('general')
    expect(settings.get().git.backgroundFetch).toBe(false)
    expect(settings.get().general.sendKey).toBe('enter')
    expect(sent).toEqual([])
  })

  it("applies the host's keys with the window's checks, and devices hear the new part", async () => {
    const { call, sent } = setup()
    const answer = await call('settings.update', {
      patch: { git: { backgroundFetch: true }, general: { sessionTitles: false } },
    })
    expect(answer).toMatchObject({
      result: { git: { backgroundFetch: true }, general: { sessionTitles: false } },
    })
    expect(settings.get().git.backgroundFetch).toBe(true)
    expect(sent).toEqual([
      {
        event: {
          type: 'settings.changed',
          settings: expect.objectContaining({ git: { backgroundFetch: true } }),
        },
        deviceId: null,
      },
    ])
    expect(await call('settings.update', { patch: { git: { backgroundFetch: 'yes' } } })).toEqual({
      error: { code: 'invalid_params', message: expect.stringContaining('git.backgroundFetch') },
    })
    expect(await call('settings.update', { patch: 'all' })).toMatchObject({
      error: { code: 'invalid_params' },
    })
  })

  it("tells devices nothing when only a client's part changes", () => {
    const { sent } = setup()
    settings.update({ appearance: { theme: 'dark' }, general: { sendKey: 'mod-enter' } })
    expect(sent).toEqual([])
    settings.update({ usage: { fromComputer: true } })
    expect(sent.map(({ event }) => event.type)).toEqual(['settings.changed'])
  })
})

describe("HostAdmin's paths", () => {
  it('adds an agent in a folder typed on a device only once the host finds it a folder', async () => {
    const { call } = setup()
    const folder = join(dir, 'typed')
    expect(
      await call('settings.addAgent', { harnessId: 'codex', name: 'Work', folder: 'typed' }),
    ).toMatchObject({
      error: { code: 'invalid_params', message: 'folder must be an absolute path' },
    })
    expect(
      await call('settings.addAgent', { harnessId: 'codex', name: 'Work', folder }),
    ).toMatchObject({
      error: { code: 'invalid_params', message: expect.stringContaining('not a folder') },
    })
    await writeFile(folder, 'a file')
    expect(
      await call('settings.addAgent', { harnessId: 'codex', name: 'Work', folder }),
    ).toMatchObject({ error: { code: 'invalid_params' } })
    await rm(folder)
    await mkdir(folder)
    expect(
      await call('settings.addAgent', { harnessId: 'codex', name: 'Work', folder: `${folder}/` }),
    ).toEqual({ result: 'codex~work' })
    expect(settings.get().addedAgents).toEqual([
      { id: 'codex~work', name: 'Work', configDir: folder, created: false },
    ])
    // A folder another agent has is refused as the dialog's is.
    expect(
      await call('settings.addAgent', { harnessId: 'claude-code', name: 'Again', folder }),
    ).toMatchObject({ error: { code: 'invalid_params', message: expect.stringContaining('Work') } })
  })

  it('makes a new folder, renames and removes an added agent as the window does', async () => {
    const { call, trashed } = setup()
    const made = await call('settings.addAgent', {
      harnessId: 'claude-code',
      name: 'Made',
      folder: null,
    })
    expect(made).toEqual({ result: 'claude-code~made' })
    expect(
      await call('settings.renameAgent', { agentId: 'claude-code~made', name: 'Mine' }),
    ).toEqual({
      result: null,
    })
    expect(settings.get().addedAgents[0]?.name).toBe('Mine')
    expect(
      await call('settings.removeAgent', { agentId: 'claude-code~made', trash: true }),
    ).toEqual({ result: null })
    expect(trashed).toEqual([join(dir, 'agent-config', 'claude-code~made')])
    expect(
      await call('settings.removeAgent', { agentId: 'claude-code~made', trash: true }),
    ).toMatchObject({
      error: { code: 'invalid_params', message: expect.stringContaining('No added agent') },
    })
  })

  posixIt('takes only a program the host may run for an agent or the shell', async () => {
    const { call } = setup()
    const program = join(dir, 'claude')
    const text = join(dir, 'notes.txt')
    await writeFile(program, '#!/bin/sh\n')
    await chmod(program, 0o755)
    await writeFile(text, 'notes')
    for (const path of ['bin/claude', join(dir, 'missing'), text, dir]) {
      expect(
        await call('settings.setAgentBinary', { harnessId: 'claude-code', path }),
      ).toMatchObject({ error: { code: 'invalid_params' } })
      expect(await call('settings.setShellPath', { path })).toMatchObject({
        error: { code: 'invalid_params' },
      })
    }
    expect(
      await call('settings.setAgentBinary', { harnessId: 'nope', path: program }),
    ).toMatchObject({
      error: { code: 'invalid_params', message: 'Unknown harness "nope"' },
    })
    expect(settings.get().agents['claude-code']?.binaryPath).toBeUndefined()

    expect(
      await call('settings.setAgentBinary', { harnessId: 'claude-code', path: program }),
    ).toMatchObject({ result: { agents: { 'claude-code': { binaryPath: program } } } })
    expect(await call('settings.setShellPath', { path: program })).toMatchObject({
      result: { terminal: { shellPath: program } },
    })
    expect(settings.get().terminal.shellPath).toBe(program)
  })
})

describe("HostAdmin's remote access", () => {
  it('sends a code opened on a device its progress alone, and lets only it answer', async () => {
    const { call, sent, closed, answered, listeners } = setup()
    expect(await call('remote.pair')).toEqual({ result: 1 })
    listeners.get(1)!({ state: 'waiting', link: 'https://kettu.sh/pair#x', expiresAt: 1 })
    expect(sent).toEqual([
      {
        event: {
          type: 'remote.pairing',
          event: {
            codeId: 1,
            pairing: { state: 'waiting', link: 'https://kettu.sh/pair#x', expiresAt: 1 },
          },
        },
        deviceId: PHONE,
      },
    ])
    // Another device can neither answer nor close it.
    await call('remote.answerPairing', { codeId: 1, add: true, name: 'iPad' }, TABLET)
    await call('remote.closePairing', { codeId: 1 }, TABLET)
    expect(answered).toEqual([])
    expect(closed).toEqual([])
    expect(await call('remote.answerPairing', { codeId: 1, add: true, name: '' })).toMatchObject({
      error: { code: 'invalid_params', message: 'A device needs a name' },
    })
    await call('remote.answerPairing', { codeId: 1, add: true, name: ' iPad ' })
    expect(answered).toEqual([[1, true, 'iPad']])
    await call('remote.closePairing', { codeId: 1 })
    expect(closed).toEqual([1])
  })

  it("voids a device's code once it has no session open, as a closed window's", async () => {
    const { admin, call, closed, sent } = setup()
    await call('remote.pair')
    admin.remoteChanged(status([PHONE, TABLET]))
    expect(closed).toEqual([])
    admin.remoteChanged(status([TABLET]))
    expect(closed).toEqual([1])
    // Devices hear each status once.
    admin.remoteChanged(status([TABLET]))
    expect(sent.filter(({ event }) => event.type === 'remote.changed')).toHaveLength(2)
  })

  it('renames and removes devices, answering what could not be done', async () => {
    const { call } = setup()
    expect(await call('remote.renameDevice', { id: PHONE, name: 'Mine' })).toEqual({ result: null })
    expect(await call('remote.renameDevice', { id: TABLET, name: 'Mine' })).toEqual({
      result: 'not_renamed',
    })
    expect(await call('remote.removeDevice', { id: TABLET })).toEqual({ result: 'not_removed' })
    expect(await call('remote.removeDevice', { id: 'phone' })).toMatchObject({
      error: { code: 'invalid_params', message: 'Not a device id' },
    })
    expect(await call('remote.status')).toMatchObject({ result: { online: [PHONE] } })
  })
})

describe("HostAdmin's host", () => {
  it('restarts a host, and refuses what this host does not have or know', async () => {
    const { call, restarted } = setup()
    expect(await call('host.restart', { process: 'terminal' })).toEqual({ result: null })
    expect(restarted).toEqual(['terminal'])
    expect(await call('host.restart', { process: 'remote' })).toMatchObject({
      error: { code: 'invalid_params' },
    })
    expect(await call('host.info')).toMatchObject({ result: { sharing: true, version: '1.2.3' } })
    expect(await call('sharing.status')).toMatchObject({ error: { code: 'unavailable' } })
    expect(await call('updates.check')).toMatchObject({ error: { code: 'unavailable' } })
    expect(await call('settings.delete')).toMatchObject({ error: { code: 'unknown_method' } })
    // The remote host is checked again, as a misbehaving one could name anyone.
    expect(await call('host.info', undefined, 'phone')).toMatchObject({
      error: { code: 'invalid_params' },
    })
  })
})

describe("HostAdmin's remote access switch", () => {
  it('keeps remote access on where the host is reached only through it', async () => {
    const { call } = setup({ remoteAlwaysOn: true })
    expect(await call('settings.update', { patch: { remote: { enabled: false } } })).toMatchObject({
      error: { code: 'invalid_params' },
    })
    expect(await call('settings.update', { patch: { remote: { terminal: true } } })).toMatchObject({
      result: { remote: { terminal: true } },
    })
  })

  it('reports remote access on where it is always on, whatever the file says', async () => {
    const { call, sent } = setup({ remoteAlwaysOn: true })
    expect(settings.get().remote.enabled).toBe(false)
    expect(await call('settings.get')).toMatchObject({ result: { remote: { enabled: true } } })
    settings.update({ git: { backgroundFetch: true } })
    expect(sent.at(-1)?.event).toMatchObject({
      type: 'settings.changed',
      settings: { remote: { enabled: true } },
    })
  })
})

describe("HostAdmin's themes", () => {
  const theme = (name: string, dark: Record<string, string> = {}) =>
    JSON.stringify({ kettuTheme: 1, name, light: {}, dark: { colors: dark } })

  function serveCatalog(text: string, version: string) {
    const { name } = JSON.parse(text) as { name: string }
    const entry = {
      id: 'nord',
      name,
      author: 'Someone',
      version,
      license: 'MIT',
      file: 'themes/nord.json',
      sha256: createHash('sha256').update(text).digest('hex'),
      preview: { light: {}, dark: {} },
    }
    served = {
      'index.json': JSON.stringify({ kettuCatalog: 1, themes: [entry] }),
      'themes/nord.json': text,
    }
  }

  it("installs a device's theme for that device, leaving the host's own window", async () => {
    const { call, sent, hostSelect } = setup()
    expect(await call('themes.add', { file: 'nord.json', text: theme('Nord') })).toEqual({
      result: { status: 'installed', id: 'nord', ignored: [], show: true },
    })
    expect(hostSelect).not.toHaveBeenCalled()
    expect(sent.at(-1)).toEqual({
      event: {
        type: 'themes.changed',
        themes: { installed: [expect.objectContaining({ id: 'nord' })], failed: [] },
      },
      deviceId: null,
    })
    const conflict = await call('themes.add', {
      file: 'nord.json',
      text: theme('Nord', { 'bg-app': '#000' }),
    })
    expect(conflict).toMatchObject({ result: { status: 'conflict', installedName: 'Nord' } })
    const { token } = (conflict as { result: { token: string } }).result
    expect(await call('themes.replace', { token })).toMatchObject({
      result: { status: 'installed', id: 'nord', show: true },
    })
    expect(hostSelect).not.toHaveBeenCalled()
    expect(await call('themes.add', { file: 5, text: '' })).toMatchObject({
      error: { code: 'invalid_params' },
    })
    expect(await call('themes.add', { file: 'x.json', text: null })).toMatchObject({
      error: { code: 'invalid_params' },
    })
  })

  it('shows a catalog theme on the device that installs it, but not after an update', async () => {
    const { call } = setup()
    serveCatalog(theme('Nord'), '1.0.0')
    expect(await call('themes.catalog', { refresh: true })).toMatchObject({
      result: { status: 'ok', themes: [{ id: 'nord', action: 'install' }] },
    })
    expect(await call('themes.installCatalog', { id: 'nord' })).toMatchObject({
      result: { status: 'installed', id: 'nord', show: true },
    })
    serveCatalog(theme('Nord', { 'bg-app': '#111' }), '1.1.0')
    expect(await call('themes.catalog', { refresh: true })).toMatchObject({
      result: { status: 'ok', themes: [{ id: 'nord', action: 'update' }] },
    })
    expect(await call('themes.installCatalog', { id: 'nord' })).toMatchObject({
      result: { status: 'installed', id: 'nord', show: false },
    })
  })
})

describe("HostAdmin's previews and attention", () => {
  it("gives a desktop host's preview, and says when the host has none", async () => {
    const thumbnail = vi.fn(async () => 'data:image/png;base64,AAAA')
    const desktop = setup({ thumbnail })
    const layout = [{ x: 0, y: 0, width: 10, height: 10 }]
    expect(await desktop.call('artifacts.thumbnail', { id: 'a1', version: 2, layout })).toEqual({
      result: 'data:image/png;base64,AAAA',
    })
    expect(thumbnail).toHaveBeenCalledWith('a1', 2, layout)
    expect(
      await setup().call('artifacts.thumbnail', { id: 'a1', version: 2, layout: null }),
    ).toMatchObject({ error: { code: 'unavailable' } })
  })

  it('tells every device what needs the user, as its own window is told', () => {
    const { admin, sent } = setup()
    admin.attention({
      type: 'host:attention',
      kind: 'routine-paused',
      agentId: 'claude-code',
      title: 'Routines paused',
      body: 'Near the plan limit',
    })
    expect(sent).toEqual([
      {
        event: {
          type: 'attention',
          attention: {
            kind: 'routine-paused',
            agentId: 'claude-code',
            title: 'Routines paused',
            body: 'Near the plan limit',
          },
        },
        deviceId: null,
      },
    ])
  })
})

describe("HostAdmin's updates", () => {
  const status = (kind: 'available' | 'downloading'): UpdateStatus =>
    ({ state: { kind, version: '2.0.0' } }) as unknown as UpdateStatus

  function updates(download: () => Promise<void>): AdminUpdates {
    return {
      getStatus: () => status('available'),
      check: async () => status('available'),
      download,
      cancel: () => {},
      restart: () => {},
      dismiss: () => {},
    }
  }

  it('answers a download once it has started, not when it ends', async () => {
    let admin: HostAdmin | null = null
    const ctx = setup({
      updates: updates(() => {
        // The download goes on for minutes; it says it started at once.
        queueMicrotask(() => admin!.updatesChanged(status('downloading')))
        return new Promise(() => {})
      }),
    })
    admin = ctx.admin
    expect(await ctx.call('updates.download')).toEqual({ result: null })
  })

  it('answers why a download could not start', async () => {
    const { call } = setup({
      updates: updates(async () => {
        throw new Error('There is no update to download')
      }),
    })
    expect(await call('updates.download')).toEqual({
      error: { code: 'internal', message: 'There is no update to download' },
    })
  })
})
