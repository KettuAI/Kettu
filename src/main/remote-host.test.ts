import { EventEmitter } from 'node:events'
import path from 'node:path'
import type { MessagePortMain } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RemoteHostStatus } from '@shared/host-control'
import type { PairedDevice, PortDevice } from '@shared/remote/device'
import type { HostPairingState, HostStatus } from '@shared/remote/hosts'
import type { DirectSettings } from '@shared/settings'
import type { PairingState } from '@shared/remote/pairing'
import type { RemoteHostDeps } from './remote-host'

const electron = vi.hoisted(() => ({
  fork: (): unknown => null,
  channels: [] as { port1: unknown; port2: unknown }[],
}))

class FakePort extends EventEmitter {
  started = false
  closed = false
  start(): void {
    this.started = true
  }
  close(): void {
    this.closed = true
    this.emit('close')
  }
}

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => null },
  MessageChannelMain: class {
    port1 = new FakePort()
    port2 = new FakePort()
    constructor() {
      electron.channels.push(this)
    }
  },
  utilityProcess: { fork: () => electron.fork() },
}))
vi.mock('../remote-host/index?modulePath', () => ({ default: '/remote-host.js' }))

const { RemoteHost } = await import('./remote-host')
const { loadStoredDevices } = await import('./remote-devices')
const { tempFolder } = await import('../agent-host/testing/temp')
const { DeviceStore } = await import('../remote-host/devices')
const { generateKeyPair } = await import('@shared/remote/noise')

class FakeChild extends EventEmitter {
  pid = 42
  stdout = null
  stderr = null
  posted: { message: { type: string; [key: string]: unknown }; transfer: unknown[] }[] = []
  /** Whether it answers that it stopped serving by itself, as the remote host does at once. */
  answersStopServing = true
  postMessage(message: { type: string; [key: string]: unknown }, transfer: unknown[] = []): void {
    this.posted.push({ message, transfer })
    if (message.type === 'remote-host:shutdown') setImmediate(() => this.emit('exit', 0))
    if (message.type === 'remote-host:stop-serving' && this.answersStopServing) {
      const { requestId } = message
      setImmediate(() => this.emit('message', { type: 'remote-host:stop-serving', requestId }))
    }
  }
  kill(): boolean {
    this.emit('exit', 0)
    return true
  }
  types(): string[] {
    return this.posted.map(({ message }) => message.type)
  }
}

let children: FakeChild[] = []
electron.fork = () => {
  const child = new FakeChild()
  children.push(child)
  return child
}

const device: PortDevice = { id: 'b'.repeat(32), name: 'Phone' }
const port = { close: vi.fn() } as unknown as MessagePortMain
const terminalPort = { close: vi.fn() } as unknown as MessagePortMain

function makeHost(
  options: {
    identity?: () => Promise<{ privateKey: string; plainText: boolean }>
    deviceKey?: () => Promise<{ privateKey: string; plainText: boolean }>
    hostsKnown?: boolean
    dataPath?: string
    admin?: RemoteHostDeps['admin']
  } = {},
) {
  const opened: PortDevice[] = []
  const terminals: PortDevice[] = []
  const settings: { direct: DirectSettings; terminal: boolean } = {
    direct: { enabled: false, port: null, addresses: [] },
    terminal: false,
  }
  let key = 'key'
  let changes = 0
  let hostsChanges = 0
  const host = new RemoteHost({
    userDataPath: '/data',
    appVersion: '1.2.3',
    identity: options.identity ?? (async () => ({ privateKey: key, plainText: true })),
    newIdentity: async () => (key = 'new key'),
    deviceKey: options.deviceKey ?? (async () => ({ privateKey: 'device key', plainText: false })),
    devicePlatform: async () => 'macOS 26.1',
    hostsKnown: async () => options.hostsKnown ?? false,
    hostName: () => 'Studio',
    devices: () => loadStoredDevices(options.dataPath ?? '/nowhere', () => {}),
    direct: () => settings.direct,
    terminal: () => settings.terminal,
    openPort: (asked) => {
      opened.push(asked)
      return asked.name === 'Phone' ? port : null
    },
    openTerminalPort: (asked) => {
      terminals.push(asked)
      return asked.name === 'Phone' ? terminalPort : null
    },
    changed: () => changes++,
    hostsChanged: () => hostsChanges++,
    ...(options.admin ? { admin: options.admin } : {}),
  })
  return {
    host,
    opened,
    terminals,
    settings,
    changes: () => changes,
    hostsChanges: () => hostsChanges,
  }
}

const newDevice = { publicKey: 'k', name: 'Phone', kind: 'ios', platform: 'ios', model: 'iPhone' }

/** A phone paired in the data folder's device files. */
async function pairedPhone(dir: string): Promise<PairedDevice> {
  const store = await DeviceStore.load(dir, () => {})
  const key = await generateKeyPair()
  const added = await store.add({
    publicKey: Buffer.from(key.publicKey).toString('base64'),
    name: 'Phone',
    kind: 'ios',
    platform: 'iOS 26.1',
    model: 'iPhone 17 Pro',
  })
  return added!
}

/** The web client's build beside main's bundle, here beside the module's own folder. */
const WEB_ROOT = path.join(import.meta.dirname, '../web')

const namedIn = async (dir: string, id: string) =>
  (await DeviceStore.load(dir, () => {})).get(id)?.name

const status: RemoteHostStatus = {
  publicKey: 'public',
  plainTextKey: false,
  devices: [],
  online: [],
  refused: 2,
  direct: { state: 'listening', port: 50123, addresses: [{ host: '192.168.1.5', port: 50123 }] },
}

async function running(options: Parameters<typeof makeHost>[0] = {}) {
  const made = makeHost(options)
  await made.host.setEnabled(true)
  const child = children.at(-1)!
  child.emit('message', { type: 'remote-host:ready' })
  child.emit('message', { type: 'remote-host:status', status })
  return { ...made, child }
}

afterEach(() => {
  children = []
  electron.channels = []
})

const LAN = { host: '192.168.1.42', port: 51234 }
const devBox: HostStatus = {
  id: 'c'.repeat(32),
  publicKey: 'key',
  name: 'dev-box',
  platform: 'linux',
  version: '0.2.0',
  addresses: [LAN],
  deviceName: 'Studio',
  addedAt: 1,
  lastOnlineAt: 2,
  removed: false,
  connection: { state: 'online', address: LAN },
}
const link = 'https://kettu.sh/pair#AQID'

describe('RemoteHost', () => {
  it('runs while the setting is on, and tells devices why it stops', async () => {
    const { host } = makeHost()
    await host.setEnabled(true)
    expect(children).toHaveLength(1)
    expect(children[0]!.posted[0]!.message).toEqual({
      type: 'remote-host:init',
      userDataPath: '/data',
      appVersion: '1.2.3',
      platform: process.platform,
      hostName: 'Studio',
      privateKey: 'key',
      plainTextKey: true,
      direct: { enabled: false, port: null, addresses: [] },
      webRoot: WEB_ROOT,
      terminal: false,
      device: { privateKey: 'device key', platform: 'macOS 26.1' },
    })
    children[0]!.emit('message', { type: 'remote-host:ready' })
    // On again changes nothing.
    await host.setEnabled(true)
    expect(children).toHaveLength(1)

    await host.setEnabled(false)
    expect(children[0]!.posted.at(-1)!.message).toEqual({
      type: 'remote-host:shutdown',
      reason: 'remote_off',
    })
    await host.setEnabled(true)
    expect(children).toHaveLength(2)
    await host.stop()
    expect(children[1]!.posted.at(-1)!.message).toEqual({
      type: 'remote-host:shutdown',
      reason: 'stopping',
    })
    // Nothing starts it once Kettu quits.
    await host.setEnabled(true)
    expect(children).toHaveLength(2)
  })

  it("answers a device's terminal port request with the terminal host's while allowed", async () => {
    const { host, terminals, settings } = makeHost()
    await host.setEnabled(true)
    const child = children[0]!
    child.emit('message', { type: 'remote-host:ready' })
    // Not allowed: the terminal host is not even asked.
    child.emit('message', { type: 'remote-host:open-terminal-port', requestId: 1, device })
    settings.terminal = true
    child.emit('message', { type: 'remote-host:open-terminal-port', requestId: 2, device })
    child.emit('message', {
      type: 'remote-host:open-terminal-port',
      requestId: 3,
      device: { ...device, name: 'Laptop' },
    })
    child.emit('message', { type: 'remote-host:open-terminal-port', requestId: 4, device: {} })
    expect(terminals).toEqual([device, { ...device, name: 'Laptop' }])
    expect(child.posted.slice(1)).toEqual([
      { message: { type: 'remote-host:port', requestId: 1 }, transfer: [] },
      { message: { type: 'remote-host:port', requestId: 2 }, transfer: [terminalPort] },
      { message: { type: 'remote-host:port', requestId: 3 }, transfer: [] },
    ])
    await host.stop()
  })

  it('tells the process when devices may use the terminal, and each start reads it', async () => {
    const { host, settings } = makeHost()
    // Nothing runs yet, so nothing is told.
    settings.terminal = true
    host.terminalChanged()
    await host.setEnabled(true)
    const first = children[0]!
    expect(first.posted[0]!.message).toMatchObject({ type: 'remote-host:init', terminal: true })
    first.emit('message', { type: 'remote-host:ready' })
    host.terminalChanged()
    settings.terminal = false
    host.terminalChanged()
    host.terminalChanged()
    expect(first.types().filter((type) => type === 'remote-host:terminal')).toHaveLength(1)
    expect(first.posted.at(-1)!.message).toEqual({ type: 'remote-host:terminal', allowed: false })
    await host.setEnabled(false)
    await host.setEnabled(true)
    expect(children[1]!.posted[0]!.message).toMatchObject({ terminal: false })
    await host.stop()
  })

  it("answers a device's port request with the agent host's port, or none", async () => {
    const { host, opened } = makeHost()
    await host.setEnabled(true)
    const child = children[0]!
    child.emit('message', { type: 'remote-host:ready' })
    child.emit('message', { type: 'remote-host:open-port', requestId: 1, device })
    child.emit('message', {
      type: 'remote-host:open-port',
      requestId: 2,
      device: { ...device, name: 'Laptop' },
    })
    child.emit('message', { type: 'remote-host:open-port', requestId: 3, device: { id: 'x' } })
    expect(opened).toEqual([device, { ...device, name: 'Laptop' }])
    expect(child.posted.slice(1)).toEqual([
      { message: { type: 'remote-host:port', requestId: 1 }, transfer: [port] },
      { message: { type: 'remote-host:port', requestId: 2 }, transfer: [] },
    ])
    await host.stop()
  })

  it('passes devices to add and remove on, and keeps what it reports', async () => {
    const { host } = makeHost()
    expect(host.addDevice(newDevice)).toBe(false)
    await host.setEnabled(true)
    const child = children[0]!
    child.emit('message', { type: 'remote-host:ready' })
    expect(host.addDevice(newDevice)).toBe(true)
    expect(await host.removeDevice(device.id)).toBe(true)
    expect(await host.renameDevice(device.id, 'Pocket')).toBe(true)
    expect(child.types().slice(1)).toEqual([
      'remote-host:add-device',
      'remote-host:remove-device',
      'remote-host:rename-device',
    ])
    expect(host.state).toBe('starting')
    child.emit('message', { type: 'remote-host:status', status })
    expect(host.status).toEqual(status)
    expect(host.state).toBe('on')
    child.emit('message', { type: 'remote-host:status', status: { ...status, refused: -1 } })
    expect(host.status).toEqual(status)
    const failed = { ...status, direct: { state: 'failed', port: 50123, reason: 'port_in_use' } }
    child.emit('message', { type: 'remote-host:status', status: failed })
    expect(host.status).toEqual(failed)
    for (const direct of [
      undefined,
      { state: 'listening', port: 0, addresses: [] },
      { state: 'listening', port: 50123, addresses: [{ host: 'a b', port: 1 }] },
      { state: 'failed', port: 50123, reason: 'busy' },
      { state: 'on' },
    ]) {
      child.emit('message', { type: 'remote-host:status', status: { ...status, direct } })
      expect(host.status).toEqual(failed)
    }
    await host.setEnabled(false)
    expect(host.status).toBeNull()
    expect(host.state).toBe('off')
  })

  it('passes changed direct settings on, a retry, and the wake from sleep', async () => {
    const { host, settings } = makeHost()
    host.directChanged()
    host.resume()
    await host.setEnabled(true)
    const child = children[0]!
    child.emit('message', { type: 'remote-host:ready' })
    // The init carried these already.
    host.directChanged()
    settings.direct = {
      enabled: true,
      port: 50123,
      addresses: [{ host: 'studio.example.com', port: 7000 }],
    }
    host.directChanged()
    host.directChanged()
    host.resume()
    // A retry passes the same settings on again, so the port is tried anew.
    host.retryDirect()
    expect(child.posted.slice(1).map(({ message }) => message)).toEqual([
      { type: 'remote-host:direct', direct: settings.direct },
      { type: 'remote-host:resume' },
      { type: 'remote-host:direct', direct: settings.direct },
    ])
    await host.setEnabled(false)
    await host.setEnabled(true)
    expect(children[1]!.posted[0]!.message).toMatchObject({ direct: settings.direct })
    await host.stop()
  })

  it('does not start without its key', async () => {
    const { host } = makeHost({
      identity: () => Promise.reject(new Error('The keychain said no')),
    })
    await host.setEnabled(true)
    expect(children).toEqual([])
    expect(host.state).toBe('failed')
  })

  it("relays a code's progress to whoever opened it, until it is added or void", async () => {
    const { host, child } = await running()
    const heard: PairingState[] = []
    const codeId = host.pair((pairing) => heard.push(pairing))!
    expect(child.posted.at(-1)!.message).toEqual({ type: 'remote-host:pair', codeId })
    const waiting = { state: 'waiting', link: 'https://kettu.sh/pair#x', expiresAt: 1 }
    child.emit('message', { type: 'remote-host:pairing', codeId, pairing: waiting })
    child.emit('message', { type: 'remote-host:pairing', codeId: codeId + 1, pairing: waiting })
    child.emit('message', { type: 'remote-host:pairing', codeId, pairing: { state: 'odd' } })
    host.answerPairing(codeId, true, 'My iPad')
    expect(child.posted.at(-1)!.message).toEqual({
      type: 'remote-host:pair-answer',
      codeId,
      add: true,
      name: 'My iPad',
    })
    const added = { state: 'added', device: { ...newDevice, id: device.id } }
    child.emit('message', { type: 'remote-host:pairing', codeId, pairing: added })
    child.emit('message', { type: 'remote-host:pairing', codeId, pairing: waiting })
    expect(heard).toEqual([waiting, added])
    // Done with: closing it says nothing more to the remote host.
    const posted = child.posted.length
    host.closePairing(codeId)
    expect(child.posted).toHaveLength(posted)
    await host.stop()
  })

  it('voids the open codes when remote access stops', async () => {
    const { host, child } = await running()
    const heard: PairingState[] = []
    const codeId = host.pair((pairing) => heard.push(pairing))!
    host.closePairing(codeId)
    expect(child.posted.at(-1)!.message).toEqual({ type: 'remote-host:pair-close', codeId })
    host.pair((pairing) => heard.push(pairing))
    await host.setEnabled(false)
    expect(heard).toEqual([{ state: 'void', reason: 'stopped' }])
    expect(host.pair(() => {})).toBeNull()
  })

  it("asks for a device's activity, and has none when the host does not answer", async () => {
    const { host, child } = await running()
    const asked = host.activity(device.id)
    const request = child.posted.at(-1)!.message
    expect(request).toMatchObject({ type: 'remote-host:activity', id: device.id })
    const events = [{ at: 1, kind: 'connected' }]
    child.emit('message', { type: 'remote-host:activity', requestId: request.requestId, events })
    expect(await asked).toEqual(events)
    const unanswered = host.activity(device.id)
    await host.setEnabled(false)
    expect(await unanswered).toEqual([])
  })

  it("hands an owner's call to its handler and posts the answer under the call's id", async () => {
    const asked: unknown[][] = []
    const { host, child } = await running({
      admin: async (...call) => {
        asked.push(call)
        return call[1] === 'remote.status'
          ? { result: 'on' }
          : { error: { code: 'busy', message: 'x' } }
      },
    })
    const admin = (requestId: unknown, method: string) =>
      child.emit('message', {
        type: 'remote-host:admin-call',
        requestId,
        deviceId: device.id,
        method,
        params: { a: 1 },
      })
    admin(7, 'remote.status')
    admin(8, 'host.info')
    // A call it could not answer under its id is dropped.
    admin('nine', 'host.info')
    await vi.waitFor(() =>
      expect(child.types().filter((type) => type === 'remote-host:admin-result')).toHaveLength(2),
    )
    const results = child.posted.flatMap(({ message }) =>
      message.type === 'remote-host:admin-result' ? [message] : [],
    )
    expect(results).toEqual([
      { type: 'remote-host:admin-result', requestId: 7, result: 'on' },
      { type: 'remote-host:admin-result', requestId: 8, error: { code: 'busy', message: 'x' } },
    ])
    expect(asked).toEqual([
      [device.id, 'remote.status', { a: 1 }],
      [device.id, 'host.info', { a: 1 }],
    ])

    // Events go to the devices only while the process serves them.
    const event = { type: 'sharing.changed', status: {} } as Parameters<typeof host.adminEvent>[0]
    host.adminEvent(event, device.id)
    expect(child.posted.at(-1)!.message).toEqual({
      type: 'remote-host:admin-event',
      event,
      deviceId: device.id,
    })
    await host.setEnabled(false)
    const posted = child.posted.length
    host.adminEvent(event, null)
    expect(child.posted).toHaveLength(posted)
  })

  it('resets: every device removed, then a new identity in the same process', async () => {
    const { host, child } = await running()
    const resetting = host.reset()
    await vi.waitFor(() => expect(child.types().at(-1)).toBe('remote-host:reset'))
    const { requestId } = child.posted.at(-1)!.message
    child.emit('message', { type: 'remote-host:reset', requestId })
    await resetting
    // The hosts this computer connects to stay connected meanwhile.
    expect(children).toHaveLength(1)
    expect(child.posted.slice(-2).map(({ message }) => message)).toEqual([
      { type: 'remote-host:stop-serving', requestId: expect.any(Number) },
      {
        type: 'remote-host:serve',
        privateKey: 'new key',
        plainTextKey: true,
        direct: { enabled: false, port: null, addresses: [] },
      },
    ])
    expect(host.status).toBeNull()
    child.emit('message', { type: 'remote-host:status', status: { ...status, publicKey: 'new' } })
    expect(host.state).toBe('on')
    await host.stop()
  })

  it('lists, renames and removes the stored devices while remote access is off', async () => {
    const dir = await tempFolder('kettu-remote-off-')
    const phone = await pairedPhone(dir)
    const { host, changes } = makeHost({ dataPath: dir })
    await host.setEnabled(false)
    expect(children).toEqual([])
    expect(host.state).toBe('off')
    expect(host.devices).toEqual([phone])

    const before = changes()
    expect(await host.renameDevice(phone.id, 'Pocket')).toBe(true)
    expect(host.devices).toEqual([{ ...phone, name: 'Pocket' }])
    expect(changes()).toBeGreaterThan(before)
    expect(await namedIn(dir, phone.id)).toBe('Pocket')
    expect(await host.activity(phone.id)).toEqual([
      { at: expect.any(Number), kind: 'renamed', from: 'Phone', to: 'Pocket', by: 'owner' },
    ])
    expect(await host.renameDevice('d'.repeat(32), 'Desk')).toBe(false)

    expect(await host.removeDevice(phone.id)).toBe(true)
    expect(await host.removeDevice(phone.id)).toBe(false)
    expect(host.devices).toEqual([])
    expect((await DeviceStore.load(dir, () => {})).list()).toEqual([])
    expect((await host.activity(phone.id))[0]).toMatchObject({ kind: 'removed', by: 'owner' })
    // Only adding a device waits for remote access.
    expect(host.addDevice(newDevice)).toBe(false)
    expect(host.pair(() => {})).toBeNull()
    expect(children).toEqual([])
  })

  it('hands the device files to the remote host to serve, and takes them back after', async () => {
    const dir = await tempFolder('kettu-remote-off-')
    const phone = await pairedPhone(dir)
    const { host } = makeHost({ dataPath: dir, hostsKnown: true })
    await host.setEnabled(false)
    const child = children[0]!
    child.emit('message', { type: 'remote-host:ready' })
    expect(host.devices).toEqual([phone])
    expect(await host.renameDevice(phone.id, 'Pocket')).toBe(true)
    expect(child.types()).not.toContain('remote-host:rename-device')

    // The remote host reads the files as it starts serving, then has them to itself.
    await host.setEnabled(true)
    expect(child.types().at(-1)).toBe('remote-host:serve')
    expect(await namedIn(dir, phone.id)).toBe('Pocket')
    const served = { ...phone, name: 'Pocket' }
    child.emit('message', { type: 'remote-host:status', status: { ...status, devices: [served] } })
    expect(host.devices).toEqual([served])
    expect(await host.renameDevice(phone.id, 'Desk')).toBe(true)
    expect(child.posted.at(-1)!.message).toEqual({
      type: 'remote-host:rename-device',
      id: phone.id,
      name: 'Desk',
    })

    // Off again, main reads them once the remote host has written them for the last time.
    child.answersStopServing = false
    let off = false
    const stopping = host.setEnabled(false).then(() => (off = true))
    await vi.waitFor(() => expect(child.types().at(-1)).toBe('remote-host:stop-serving'))
    const store = await DeviceStore.load(dir, () => {})
    await store.rename(phone.id, 'Desk')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(off).toBe(false)
    expect(host.devices).toEqual([served])
    const { requestId } = child.posted.at(-1)!.message
    child.emit('message', { type: 'remote-host:stop-serving', requestId })
    await stopping
    expect(host.devices).toEqual([{ ...phone, name: 'Desk' }])
    await host.stop()
  })

  it('does not reset while remote access is off', async () => {
    const { host } = makeHost()
    await expect(host.reset()).rejects.toThrow('Remote access is not on')
    // The failed reset leaves later changes to run.
    await host.setEnabled(true)
    expect(children).toHaveLength(1)
    await host.stop()
  })

  it('runs for the hosts it knows while remote access is off, serving no device', async () => {
    const { host } = makeHost({ hostsKnown: true })
    await host.setEnabled(false)
    expect(children).toHaveLength(1)
    const child = children[0]!
    expect(child.posted[0]!.message).toEqual({
      type: 'remote-host:init',
      userDataPath: '/data',
      appVersion: '1.2.3',
      platform: process.platform,
      hostName: 'Studio',
      plainTextKey: false,
      direct: { enabled: false, port: null, addresses: [] },
      webRoot: WEB_ROOT,
      terminal: false,
      device: { privateKey: 'device key', platform: 'macOS 26.1' },
    })
    expect(host.state).toBe('off')
    expect(host.hosts).toBeNull()
    expect(host.pair(() => {})).toBeNull()
    child.emit('message', { type: 'remote-host:ready' })

    // On: the same process serves devices too, and off again it stops only that.
    await host.setEnabled(true)
    expect(child.posted.at(-1)!.message).toEqual({
      type: 'remote-host:serve',
      privateKey: 'key',
      plainTextKey: true,
      direct: { enabled: false, port: null, addresses: [] },
    })
    expect(host.state).toBe('starting')
    child.emit('message', { type: 'remote-host:status', status })
    expect(host.state).toBe('on')
    await host.setEnabled(false)
    expect(child.posted.at(-1)!.message).toEqual({
      type: 'remote-host:stop-serving',
      requestId: expect.any(Number),
    })
    expect(host.state).toBe('off')
    expect(host.status).toBeNull()
    expect(host.addDevice(newDevice)).toBe(false)
    expect(children).toHaveLength(1)

    // The last host forgotten here, nothing needs the process.
    child.emit('message', { type: 'remote-host:hosts', hosts: [] })
    await vi.waitFor(() =>
      expect(child.posted.at(-1)!.message).toEqual({
        type: 'remote-host:shutdown',
        reason: 'remote_off',
      }),
    )
    expect(host.hosts).toEqual([])
  })

  it('keeps the hosts it reports, and passes changes to them on', async () => {
    const { host, hostsChanges } = makeHost({ hostsKnown: true })
    await host.setEnabled(false)
    const child = children[0]!
    child.emit('message', { type: 'remote-host:ready' })
    child.emit('message', { type: 'remote-host:hosts', hosts: [devBox] })
    expect(host.hosts).toEqual([devBox])
    expect(hostsChanges()).toBeGreaterThan(0)
    child.emit('message', { type: 'remote-host:hosts', hosts: [{ ...devBox, id: 'x' }] })
    expect(host.hosts).toEqual([devBox])

    expect(host.renameOnHost(devBox.id, 'Desk')).toBe(true)
    expect(host.setHostAddresses(devBox.id, [LAN])).toBe(true)
    expect(host.removeHost(devBox.id)).toBe(true)
    expect(host.removeHost('d'.repeat(32))).toBe(false)
    expect(child.posted.slice(-3).map(({ message }) => message)).toEqual([
      { type: 'remote-host:rename-on-host', id: devBox.id, name: 'Desk' },
      { type: 'remote-host:host-addresses', id: devBox.id, addresses: [LAN] },
      { type: 'remote-host:remove-host', id: devBox.id },
    ])
    // A host not connected cannot hear a new name.
    child.emit('message', {
      type: 'remote-host:hosts',
      hosts: [{ ...devBox, connection: { state: 'offline' } }],
    })
    expect(host.renameOnHost(devBox.id, 'Desk')).toBe(false)
    await host.stop()
  })

  it("hands a host's session a port of main's, closed with the process", async () => {
    const { host } = makeHost({ hostsKnown: true })
    await host.setEnabled(false)
    const child = children[0]!
    child.emit('message', { type: 'remote-host:ready' })
    child.emit('message', { type: 'remote-host:open-host-port', requestId: 5, hostId: devBox.id })
    const [channel] = electron.channels as { port1: FakePort; port2: FakePort }[]
    expect(child.posted.at(-1)).toEqual({
      message: { type: 'remote-host:host-port', requestId: 5 },
      transfer: [channel!.port1],
    })
    expect(channel!.port2.started).toBe(true)
    child.emit('exit', 1)
    expect(channel!.port2.closed).toBe(true)
    await host.stop()
  })

  it('starts for Add host, and keeps running once the host is added', async () => {
    const { host } = makeHost()
    const heard: [number, HostPairingState][] = []
    const pairId = await host.pairHost(link, 'MacBook Pro', (id, pairing) =>
      heard.push([id, pairing]),
    )
    expect(pairId).not.toBeNull()
    expect(children).toHaveLength(1)
    const child = children[0]!
    expect(child.posted[0]!.message).not.toHaveProperty('privateKey')
    expect(child.posted.at(-1)!.message).toEqual({
      type: 'remote-host:pair-host',
      pairId,
      link,
      model: 'MacBook Pro',
    })
    child.emit('message', { type: 'remote-host:ready' })
    child.emit('message', {
      type: 'remote-host:host-pairing',
      pairId,
      pairing: { state: 'confirm' },
    })
    child.emit('message', { type: 'remote-host:host-pairing', pairId, pairing: { state: 'odd' } })
    child.emit('message', { type: 'remote-host:hosts', hosts: [devBox] })
    child.emit('message', {
      type: 'remote-host:host-pairing',
      pairId,
      pairing: { state: 'added', host: devBox },
    })
    expect(heard).toEqual([
      [pairId, { state: 'confirm' }],
      [pairId, { state: 'added', host: devBox }],
    ])
    // Known now, the host keeps the process running with remote access off.
    await host.setEnabled(false)
    expect(child.types()).not.toContain('remote-host:shutdown')
    await host.stop()
  })

  it('stops again when a pairing ends with nothing added and nothing else needs it', async () => {
    const { host } = makeHost()
    const failed = await host.pairHost(link, '', () => {})
    const child = children[0]!
    child.emit('message', { type: 'remote-host:ready' })
    child.emit('message', {
      type: 'remote-host:host-pairing',
      pairId: failed,
      pairing: { state: 'failed', reason: 'void' },
    })
    await vi.waitFor(() => expect(child.types().at(-1)).toBe('remote-host:shutdown'))

    const closed = (await host.pairHost(link, '', () => {}))!
    const next = children[1]!
    host.closeHostPairing(closed)
    await vi.waitFor(() => expect(next.types().at(-1)).toBe('remote-host:shutdown'))
    expect(next.posted.at(-2)!.message).toEqual({
      type: 'remote-host:pair-host-close',
      pairId: closed,
    })
  })

  it('pairs with no host without the device key, and says so', async () => {
    const { host } = makeHost({
      deviceKey: () => Promise.reject(new Error('The keychain said no')),
    })
    expect(await host.pairHost(link, '', () => {})).toBeNull()
    expect(host.deviceKeyFailed).toBe(true)
    expect(children).toEqual([])
    // Remote access still runs without it.
    await host.setEnabled(true)
    expect(children[0]!.posted[0]!.message).not.toHaveProperty('device')
    await host.stop()
  })
})
