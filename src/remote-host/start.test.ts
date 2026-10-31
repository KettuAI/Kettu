// The remote host as main drives it over its control channel, in this process: turning remote
// access off leaves the device files to main only once the remote host is done with them.

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { MainToRemoteHost, RemoteHostToMain } from '@shared/host-control'
import { generateKeyPair, importKeyPair } from '@shared/remote/noise'
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
