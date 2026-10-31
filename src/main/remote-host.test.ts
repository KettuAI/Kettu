import { EventEmitter } from 'node:events'
import type { MessagePortMain } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RemoteHostStatus } from '@shared/host-control'
import type { PortDevice } from '@shared/remote/device'
import type { DirectSettings } from '@shared/settings'

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
  const host = new RemoteHost({
    userDataPath: '/data',
    appVersion: '1.2.3',
    identity: options.identity ?? (async () => ({ privateKey: 'key', plainText: true })),
    hostName: () => 'Studio',
    direct: () => settings.direct,
    openPort: (asked) => {
      opened.push(asked)
      return asked.name === 'Phone' ? port : null
    },
  })
  return { host, opened, settings }
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
    expect(host.addDevice({ publicKey: 'k', name: 'Phone', kind: 'ios', platform: 'ios' })).toBe(
      false,
    )
    await host.setEnabled(true)
    const child = children[0]!
    child.emit('message', { type: 'remote-host:ready' })
    expect(host.addDevice({ publicKey: 'k', name: 'Phone', kind: 'ios', platform: 'ios' })).toBe(
      true,
    )
    expect(host.removeDevice(device.id)).toBe(true)
    expect(child.types().slice(1)).toEqual(['remote-host:add-device', 'remote-host:remove-device'])

    const status: RemoteHostStatus = {
      publicKey: 'public',
      plainTextKey: false,
      devices: [],
      online: [],
      refused: 2,
      direct: {
        state: 'listening',
        port: 50123,
        addresses: [{ host: '192.168.1.5', port: 50123 }],
      },
    }
    child.emit('message', { type: 'remote-host:status', status })
    expect(host.status).toEqual(status)
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
  })

  it('passes changed direct settings on, and the wake from sleep', async () => {
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
    expect(child.posted.slice(1).map(({ message }) => message)).toEqual([
      { type: 'remote-host:direct', direct: settings.direct },
      { type: 'remote-host:resume' },
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
  })
})
