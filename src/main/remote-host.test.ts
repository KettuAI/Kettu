import { EventEmitter } from 'node:events'
import type { MessagePortMain } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RemoteHostStatus } from '@shared/host-control'
import type { PortDevice } from '@shared/remote/device'
import type { DirectSettings } from '@shared/settings'
import type { PairingState } from '@shared/remote/pairing'

const electron = vi.hoisted(() => ({ fork: (): unknown => null }))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => null },
  MessageChannelMain: class {},
  utilityProcess: { fork: () => electron.fork() },
}))
vi.mock('../remote-host/index?modulePath', () => ({ default: '/remote-host.js' }))

const { RemoteHost } = await import('./remote-host')

class FakeChild extends EventEmitter {
  pid = 42
  stdout = null
  stderr = null
  posted: { message: { type: string; [key: string]: unknown }; transfer: unknown[] }[] = []
  postMessage(message: { type: string }, transfer: unknown[] = []): void {
    this.posted.push({ message, transfer })
    if (message.type === 'remote-host:shutdown') setImmediate(() => this.emit('exit', 0))
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

function makeHost(
  options: { identity?: () => Promise<{ privateKey: string; plainText: boolean }> } = {},
) {
  const opened: PortDevice[] = []
  const settings: { direct: DirectSettings } = {
    direct: { enabled: false, port: null, addresses: [] },
  }
  let key = 'key'
  let changes = 0
  const host = new RemoteHost({
    userDataPath: '/data',
    appVersion: '1.2.3',
    identity: options.identity ?? (async () => ({ privateKey: key, plainText: true })),
    newIdentity: async () => (key = 'new key'),
    hostName: () => 'Studio',
    direct: () => settings.direct,
    openPort: (asked) => {
      opened.push(asked)
      return asked.name === 'Phone' ? port : null
    },
    changed: () => changes++,
  })
  return { host, opened, settings, changes: () => changes }
}

const newDevice = { publicKey: 'k', name: 'Phone', kind: 'ios', platform: 'ios', model: 'iPhone' }

const status: RemoteHostStatus = {
  publicKey: 'public',
  plainTextKey: false,
  devices: [],
  online: [],
  refused: 2,
  direct: { state: 'listening', port: 50123, addresses: [{ host: '192.168.1.5', port: 50123 }] },
}

async function running() {
  const made = makeHost()
  await made.host.setEnabled(true)
  const child = children.at(-1)!
  child.emit('message', { type: 'remote-host:ready' })
  child.emit('message', { type: 'remote-host:status', status })
  return { ...made, child }
}

afterEach(() => {
  children = []
})

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
    expect(host.removeDevice(device.id)).toBe(true)
    expect(host.renameDevice(device.id, 'Pocket')).toBe(true)
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

  it('resets: every device removed, then a new identity and a new start', async () => {
    const { host, child } = await running()
    const resetting = host.reset()
    await vi.waitFor(() => expect(child.types().at(-1)).toBe('remote-host:reset'))
    const { requestId } = child.posted.at(-1)!.message
    child.emit('message', { type: 'remote-host:reset', requestId })
    await resetting
    expect(child.posted.at(-1)!.message).toEqual({
      type: 'remote-host:shutdown',
      reason: 'remote_off',
    })
    expect(children).toHaveLength(2)
    expect(children[1]!.posted[0]!.message).toMatchObject({
      type: 'remote-host:init',
      privateKey: 'new key',
    })
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
})
