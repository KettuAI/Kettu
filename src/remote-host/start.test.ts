// The remote host as main drives it over its control channel, in this process: turning remote
// access off leaves the device files to main only once the remote host is done with them, and an
// owner's calls beyond its sessions go to main, whose answers and events come back.

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { HostMethod } from '@shared/agent-host'
import type { MainToRemoteHost, RemoteHostToMain } from '@shared/host-control'
import type { HostAdminEvent } from '@shared/remote/host-admin'
import { generateKeyPair, importKeyPair, type KeyPair } from '@shared/remote/noise'
import { tempFolder } from '../agent-host/testing/temp'
import { startRemoteHost } from './start'
import { connectDevice } from './testing/device'
import { memoryPorts, memoryTransports } from './testing/memory'

const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')

describe('the remote host', () => {
  it('says it stopped serving once it wrote the device files for the last time', async () => {
    const data = await tempFolder('kettu-start-')
    const sent: RemoteHostToMain[] = []
    let deliver: (message: MainToRemoteHost) => void = () => {}
    const host = startRemoteHost(
      { send: (message) => sent.push(message), onMessage: (listener) => (deliver = listener) },
      { openAgentPort: async () => memoryPorts()[0], openTerminalPort: async () => null },
    )
    const privateKey = new Uint8Array(32).fill(7)
    deliver({
      type: 'remote-host:init',
      userDataPath: data,
      appVersion: '0.0.0-test',
      platform: process.platform,
      hostName: 'Studio',
      privateKey: base64(privateKey),
      plainTextKey: false,
      terminal: false,
    })
    const statuses = () =>
      sent.flatMap((message) => (message.type === 'remote-host:status' ? [message.status] : []))
    await expect.poll(() => statuses().length).toBeGreaterThan(0)
    const phone = await generateKeyPair()
    deliver({
      type: 'remote-host:add-device',
      device: {
        publicKey: base64(phone.publicKey),
        name: 'Phone',
        kind: 'ios',
        platform: 'iOS 26.1',
        model: 'iPhone 17 Pro',
      },
    })
    await expect.poll(() => statuses().at(-1)?.devices.length).toBe(1)
    const [deviceEnd, hostEnd] = memoryTransports()
    host.accept(hostEnd)
    const device = await connectDevice({
      transport: deviceEnd,
      hostKey: (await importKeyPair(privateKey)).publicKey,
      key: phone,
    })
    expect(await device.first).toMatchObject({ type: 'welcome' })

    const off = Date.now()
    deliver({ type: 'remote-host:stop-serving', requestId: 3 })
    await expect.poll(() => sent).toContainEqual({ type: 'remote-host:stop-serving', requestId: 3 })
    expect(await device.closing).toEqual({ type: 'closing', reason: 'remote_off' })
    // The session's end is the device's last connection, on disk before the answer.
    const file = JSON.parse(await readFile(path.join(data, 'remote', 'devices.json'), 'utf8'))
    expect(file.devices[0].lastConnectedAt).toBeGreaterThanOrEqual(off)
  })
})

describe("an owner's calls through the remote host", () => {
  async function serving() {
    const data = await tempFolder('kettu-start-admin-')
    const sent: RemoteHostToMain[] = []
    let deliver: (message: MainToRemoteHost) => void = () => {}
    // What reached the agent host.
    const forwarded: unknown[] = []
    const host = startRemoteHost(
      { send: (message) => sent.push(message), onMessage: (listener) => (deliver = listener) },
      {
        openAgentPort: async () => {
          const [remoteEnd, agentEnd] = memoryPorts()
          agentEnd.onMessage((message) => forwarded.push(message))
          return remoteEnd
        },
        openTerminalPort: async () => null,
      },
    )
    const privateKey = new Uint8Array(32).fill(9)
    deliver({
      type: 'remote-host:init',
      userDataPath: data,
      appVersion: '0.0.0-test',
      platform: process.platform,
      hostName: 'Studio',
      privateKey: base64(privateKey),
      plainTextKey: false,
      terminal: false,
    })
    const statuses = () =>
      sent.flatMap((message) => (message.type === 'remote-host:status' ? [message.status] : []))
    await expect.poll(() => statuses().length).toBeGreaterThan(0)
    const hostKey = (await importKeyPair(privateKey)).publicKey
    const pair = async (name: string) => {
      const key = await generateKeyPair()
      deliver({
        type: 'remote-host:add-device',
        device: {
          publicKey: base64(key.publicKey),
          name,
          kind: 'ios',
          platform: 'iOS',
          model: name,
        },
      })
      const added = () =>
        statuses()
          .at(-1)
          ?.devices.find((device) => device.name === name)
      await expect.poll(added).toBeDefined()
      return { key, id: added()!.id }
    }
    const connect = async (key: KeyPair) => {
      const [deviceEnd, hostEnd] = memoryTransports()
      host.accept(hostEnd)
      const device = await connectDevice({ transport: deviceEnd, hostKey, key })
      expect(await device.first).toMatchObject({ type: 'welcome', role: 'owner' })
      return device
    }
    const calls = () =>
      sent.flatMap((message) => (message.type === 'remote-host:admin-call' ? [message] : []))
    return { deliver, forwarded, pair, connect, calls }
  }

  it('reach main with the device, and its result or error comes back as the answer', async () => {
    const t = await serving()
    const phone = await t.pair('Phone')
    const device = await t.connect(phone.key)
    const request = (method: string, params?: unknown) =>
      device.port.request(method as HostMethod, params as never)

    const info = request('host.info')
    await expect.poll(() => t.calls()).toHaveLength(1)
    const [asked] = t.calls()
    expect(asked).toEqual({
      type: 'remote-host:admin-call',
      requestId: expect.any(Number),
      deviceId: phone.id,
      method: 'host.info',
    })
    t.deliver({ type: 'remote-host:admin-result', requestId: asked!.requestId, result: { a: 1 } })
    expect(await info).toEqual({ a: 1 })

    const update = request('settings.update', { patch: { git: { backgroundFetch: 1 } } })
    await expect.poll(() => t.calls()).toHaveLength(2)
    const second = t.calls()[1]!
    expect(second.params).toEqual({ patch: { git: { backgroundFetch: 1 } } })
    t.deliver({
      type: 'remote-host:admin-result',
      requestId: second.requestId,
      error: { code: 'invalid_params', message: '"git.backgroundFetch" must be a boolean' },
    })
    await expect(update).rejects.toMatchObject({
      code: 'invalid_params',
      message: '"git.backgroundFetch" must be a boolean',
    })
    // An answer to a call already answered changes nothing.
    t.deliver({ type: 'remote-host:admin-result', requestId: second.requestId, result: 'late' })

    // The rest still goes to the agent host, and these never did.
    void device.port.request('projects.list', undefined)
    await expect.poll(() => t.forwarded).toHaveLength(1)
    expect(t.forwarded[0]).toMatchObject({ type: 'request', method: 'projects.list' })
  })

  it("sends main's events to every device, or only to the one they are for", async () => {
    const t = await serving()
    const phone = await t.pair('Phone')
    const tablet = await t.pair('Tablet')
    const onPhone = await t.connect(phone.key)
    const onTablet = await t.connect(tablet.key)
    const updates: HostAdminEvent = {
      type: 'updates.changed',
      status: {
        state: { kind: 'idle', checkedAt: null },
        mode: 'install',
        readOnly: false,
        current: '1.0.0',
        updatedFrom: null,
        dismissed: null,
      },
    }
    const pairing: HostAdminEvent = {
      type: 'remote.pairing',
      event: { codeId: 4, pairing: { state: 'void', reason: 'expired' } },
    }
    t.deliver({ type: 'remote-host:admin-event', event: updates, deviceId: null })
    t.deliver({ type: 'remote-host:admin-event', event: pairing, deviceId: phone.id })
    // Not an event a device hears, so none does.
    t.deliver({
      type: 'remote-host:admin-event',
      event: { type: 'session.summary' } as unknown as HostAdminEvent,
      deviceId: null,
    })
    await expect.poll(() => onPhone.port.events).toEqual([updates, pairing])
    await expect.poll(() => onTablet.port.events).toEqual([updates])
  })
})
