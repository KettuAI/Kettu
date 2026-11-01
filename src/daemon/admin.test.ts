import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { HostAdminEvent } from '@shared/remote/host-admin'
import type { PairingState } from '@shared/remote/pairing'
import type { RemoteStatus } from '@shared/remote/status'
import { tempFolder } from '../agent-host/testing/temp'
import { SettingsStore } from '../main/settings'
import type { SettingsSection } from '../main/settings-schema'
import { startDaemonAdmin, type DaemonHosts } from './admin'
import { ControlError } from './control'

const PHONE = 'a'.repeat(32)

/** The daemon's hosts as the owner's calls reach them, recording what they are told. */
class FakeHosts implements DaemonHosts {
  readonly changes: SettingsSection[][] = []
  readonly events: { event: HostAdminEvent; deviceId: string | null }[] = []
  readonly restarted: string[] = []
  running = true
  online: string[] = [PHONE]
  private readonly listeners = new Set<() => void>()
  pairings = new Map<number, (pairing: PairingState) => void>()

  remoteAccess(): RemoteStatus {
    return {
      state: this.running ? 'on' : 'starting',
      hostName: 'server',
      systemName: 'server',
      devices: [],
      online: this.online,
      plainTextKey: true,
      direct: { state: 'off' },
    }
  }
  onRemoteChanged(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  report(): void {
    for (const listener of this.listeners) listener()
  }
  pair(listener: (pairing: PairingState) => void): number {
    if (!this.running) throw new ControlError('unavailable', 'Remote access is not running')
    this.pairings.set(1, listener)
    return 1
  }
  closePairing(codeId: number): void {
    this.pairings.delete(codeId)
  }
  answerPairing(): void {
    throw new ControlError('not_found', 'The code is not open')
  }
  renameDevice(id: string): boolean {
    return id === PHONE
  }
  async removeDevice(id: string): Promise<void> {
    if (id !== PHONE) throw new ControlError('not_found', `No device ${id}`)
  }
  async activity() {
    return []
  }
  retryDirect(): void {}
  restart(name: 'agent' | 'terminal'): boolean {
    this.restarted.push(name)
    return true
  }
  adminEvent(event: HostAdminEvent, deviceId: string | null): void {
    this.events.push({ event, deviceId })
  }
  settingsChanged(changed: ReadonlySet<SettingsSection>): void {
    this.changes.push([...changed])
  }
}

async function setup() {
  const dataPath = await tempFolder('kettu-daemon-admin-')
  const settings = await SettingsStore.load(dataPath)
  const hosts = new FakeHosts()
  const admin = startDaemonAdmin({ dataPath, version: '1.2.3', settings, hosts })
  const call = (method: string, params?: unknown) => admin.answer(PHONE, method, params)
  return { dataPath, settings, hosts, admin, call }
}

describe("the daemon's answers to its owner's devices", () => {
  it('changes its own settings, which reach the hosts and the devices', async () => {
    const t = await setup()
    expect(
      await t.call('settings.update', { patch: { usage: { fromComputer: true } } }),
    ).toMatchObject({ result: { usage: { fromComputer: true } } })
    expect(t.settings.get().usage.fromComputer).toBe(true)
    expect(t.hosts.changes).toEqual([['usage']])
    expect(t.hosts.events).toEqual([
      {
        event: {
          type: 'settings.changed',
          settings: expect.objectContaining({ usage: { fromComputer: true } }),
        },
        deviceId: null,
      },
    ])
    // A change from the CLI reaches them the same way, and a rename of the host is told at once.
    t.settings.update({ remote: { name: 'build-box', terminal: true } })
    expect(t.hosts.changes.at(-1)).toEqual(['remote'])
    expect(t.hosts.events.map(({ event }) => event.type)).toEqual([
      'settings.changed',
      'settings.changed',
      'remote.changed',
    ])
    await t.settings.flush()
  })

  it('says what it is, and that it neither publishes nor updates from Settings', async () => {
    const t = await setup()
    expect(await t.call('host.info')).toEqual({
      result: {
        name: 'Kettu',
        version: '1.2.3',
        system: expect.any(String),
        userDataPath: t.dataPath,
        isPackaged: true,
        sharing: false,
        updates: false,
        remoteSwitch: false,
        remoteReset: false,
      },
    })
    for (const method of ['sharing.status', 'sharing.connect', 'updates.check', 'remote.reset']) {
      expect(await t.call(method, {})).toMatchObject({ error: { code: 'unavailable' } })
    }
    expect(await t.call('host.restart', { process: 'agent' })).toEqual({ result: null })
    expect(t.hosts.restarted).toEqual(['agent'])
  })

  it('answers remote access from its hosts, and null for a code while it does not run', async () => {
    const t = await setup()
    expect(await t.call('remote.status')).toMatchObject({
      result: { state: 'on', online: [PHONE] },
    })
    expect(await t.call('remote.removeDevice', { id: 'b'.repeat(32) })).toEqual({
      result: 'not_removed',
    })
    expect(await t.call('remote.removeDevice', { id: PHONE })).toEqual({ result: null })
    expect(await t.call('remote.renameDevice', { id: PHONE, name: 'Mine' })).toEqual({
      result: null,
    })
    expect(await t.call('remote.pair')).toEqual({ result: 1 })
    t.hosts.pairings.get(1)!({ state: 'void', reason: 'expired' })
    expect(t.hosts.events.at(-1)).toEqual({
      event: {
        type: 'remote.pairing',
        event: { codeId: 1, pairing: { state: 'void', reason: 'expired' } },
      },
      deviceId: PHONE,
    })
    // A code is void once its device has no session open, as the remote host reports it.
    await t.call('remote.pair')
    t.hosts.online = []
    t.hosts.report()
    expect(t.hosts.pairings.size).toBe(0)
    expect(t.hosts.events.at(-1)?.event.type).toBe('remote.changed')
    t.hosts.running = false
    expect(await t.call('remote.pair')).toEqual({ result: null })
  })

  it('moves a folder it made aside, since a server has no trash', async () => {
    const t = await setup()
    vi.spyOn(Date, 'now').mockReturnValue(1234)
    const added = await t.call('settings.addAgent', {
      harnessId: 'codex',
      name: 'Work',
      folder: null,
    })
    expect(added).toEqual({ result: 'codex~work' })
    expect(await t.call('settings.removeAgent', { agentId: 'codex~work', trash: true })).toEqual({
      result: null,
    })
    const removed = path.join(t.dataPath, 'removed-agent-config')
    expect(await readdir(removed)).toEqual(['codex~work-1234'])
    expect(await readdir(path.join(t.dataPath, 'agent-config'))).toEqual([])
    if (process.platform !== 'win32') expect((await stat(removed)).mode & 0o777).toBe(0o700)
    vi.restoreAllMocks()
    await t.settings.flush()
  })
})
