// Direct connections over TCP on localhost: the listener following its settings, a device through
// the whole handshake into a session, the addresses it is told, a port in use and the limits.

import { mkdtemp, rm } from 'node:fs/promises'
import { connect, createServer, type Server, type Socket } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DirectStatus } from '@shared/host-control'
import type { PortChannel } from '@shared/port-channel'
import { generateKeyPair, type KeyPair } from '@shared/remote/noise'
import type { DirectSettings } from '@shared/settings'
import { startTestHost, type TestHost } from '../agent-host/testing/harness'
import type { Interfaces } from './addresses'
import { CHECK_ADDRESSES_MS, connectTransport, DirectListener } from './direct'
import { DeviceStore } from './devices'
import { SOURCE_BURST } from './limits'
import { RemoteServer } from './server'
import { connectDevice } from './testing/device'
import { memoryPorts } from './testing/memory'

const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')
const LOCALHOST = '127.0.0.1'

const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  vi.useRealTimers()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function nic(address: string): Interfaces[string] {
  return [
    {
      address,
      family: 'IPv4',
      internal: false,
      netmask: '255.255.255.0',
      mac: '00:00:00:00:00:00',
      cidr: null,
    },
  ]
}

async function setup(options: { agent?: boolean } = {}) {
  let agent: TestHost | null = null
  let dir: string
  if (options.agent) {
    agent = await startTestHost()
    cleanups.push(() => agent!.stop())
    dir = agent.dir
  } else {
    dir = await mkdtemp(path.join(os.tmpdir(), 'kettu-direct-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
  }
  const logs: string[] = []
  const log = (level: string, message: string): void => void logs.push(`${level}: ${message}`)
  const devices = await DeviceStore.load(dir, log)
  const hostKey = await generateKeyPair()
  const phoneKey = await generateKeyPair()
  await devices.add({
    publicKey: base64(phoneKey.publicKey),
    name: 'Phone',
    kind: 'ios',
    platform: 'ios',
  })
  const server = new RemoteServer({
    staticKey: hostKey,
    devices,
    host: { name: 'Studio', platform: process.platform, version: '0.0.0-test' },
    openAgentPort: async (device) => {
      const [remoteEnd, agentEnd] = memoryPorts()
      if (agent) agent.host.connect(agentEnd as Parameters<TestHost['host']['connect']>[0], device)
      return remoteEnd as PortChannel
    },
    changed: () => {},
    log,
  })
  let interfaces: Interfaces = { en0: nic('192.168.1.20'), lo0: [] }
  const statuses: DirectStatus[] = []
  const direct = new DirectListener({
    server,
    changed: () => statuses.push(direct.status),
    log,
    host: LOCALHOST,
    interfaces: () => interfaces,
  })
  cleanups.push(async () => {
    direct.stop()
    await server.stop('stopping')
  })
  const listening = (): Extract<DirectStatus, { state: 'listening' }> => {
    const status = direct.status
    if (status.state !== 'listening') throw new Error(`Not listening: ${JSON.stringify(status)}`)
    return status
  }
  const connectPhone = async (port = listening().port, key: KeyPair = phoneKey) => {
    const device = await connectDevice({
      transport: await connectTransport({ host: LOCALHOST, port }),
      hostKey: hostKey.publicKey,
      key,
    })
    cleanups.push(() => device.close())
    return device
  }
  return {
    agent,
    server,
    direct,
    logs,
    statuses,
    listening,
    connectPhone,
    setInterfaces: (next: Interfaces) => (interfaces = next),
  }
}

const on = (addresses: DirectSettings['addresses'] = [], port = 0): DirectSettings => ({
  enabled: true,
  port,
  addresses,
})
const off: DirectSettings = { enabled: false, port: null, addresses: [] }

/** A raw TCP connection, open once the host took it. */
function rawSocket(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: LOCALHOST, port })
    socket.once('error', reject)
    socket.once('connect', () => resolve(socket))
    cleanups.push(() => void socket.destroy())
  })
}

describe('direct connections', () => {
  it('take a device through the handshake into a session over TCP', async () => {
    const t = await setup({ agent: true })
    const frp = { host: 'frp.example.com', port: 7000 }
    await t.direct.apply(on([frp]))
    const { port, addresses } = t.listening()
    expect(port).toBeGreaterThan(0)
    expect(addresses).toEqual([frp, { host: '192.168.1.20', port }])

    const device = await t.connectPhone()
    expect(await device.first).toEqual({
      type: 'welcome',
      protocol: 1,
      host: { name: 'Studio', platform: process.platform, version: '0.0.0-test' },
      features: [],
      role: 'owner',
      terminal: false,
      addresses,
    })
    const session = await device.port.request('sessions.create', {
      agentId: 'fake-agent',
      projectPath: t.agent!.project,
    })
    await device.port.open(session.id)
    expect(device.port.summary(session.id)).toMatchObject({ id: session.id, agentId: 'fake-agent' })
    expect(t.server.online()).toHaveLength(1)
  })

  it('follow the setting on and off, keeping the port', async () => {
    const t = await setup()
    expect(t.direct.status).toEqual({ state: 'off' })
    await t.direct.apply(on())
    const { port } = t.listening()
    const device = await t.connectPhone()
    await device.first
    expect(t.server.online()).toHaveLength(1)

    await t.direct.apply(off)
    expect(t.direct.status).toEqual({ state: 'off' })
    expect(await device.closing).toBeNull()
    await expect.poll(() => t.server.online()).toEqual([])
    await expect(connectTransport({ host: LOCALHOST, port })).rejects.toMatchObject({
      code: 'ECONNREFUSED',
    })
    expect(t.statuses.at(-1)).toEqual({ state: 'off' })

    await t.direct.apply(on([], port))
    expect(t.listening().port).toBe(port)
    const again = await t.connectPhone(port)
    expect(await again.first).toMatchObject({ type: 'welcome' })
  })

  it('report a port in use and do not try it again until the settings change', async () => {
    const t = await setup()
    const blocker: Server = createServer()
    await new Promise<void>((resolve) => blocker.listen(0, LOCALHOST, resolve))
    const port = (blocker.address() as { port: number }).port
    await t.direct.apply(on([], port))
    expect(t.direct.status).toEqual({ state: 'failed', port, reason: 'port_in_use' })
    expect(t.logs).toEqual([`warn: Direct connections cannot listen on port ${port}: EADDRINUSE`])
    await new Promise<void>((resolve) => blocker.close(() => resolve()))
    t.direct.checkAddresses()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(t.direct.status).toMatchObject({ state: 'failed' })
    expect(t.statuses).toHaveLength(1)

    await t.direct.apply(off)
    await t.direct.apply(on([], port))
    expect(t.listening().port).toBe(port)
  })

  it('tell welcomed devices the addresses again when they change', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const t = await setup()
    await t.direct.apply(on())
    const { port } = t.listening()
    const device = await t.connectPhone()
    expect(await device.first).toMatchObject({ addresses: [{ host: '192.168.1.20', port }] })

    // Joined another network: read on the next check.
    t.setInterfaces({ en0: nic('10.0.0.7') })
    vi.advanceTimersByTime(CHECK_ADDRESSES_MS - 1)
    expect(t.listening().addresses).toEqual([{ host: '192.168.1.20', port }])
    vi.advanceTimersByTime(1)
    const moved = [{ host: '10.0.0.7', port }]
    expect(t.listening().addresses).toEqual(moved)
    await expect.poll(() => device.addresses).toEqual([{ type: 'addresses', addresses: moved }])

    // Woke from sleep on a VPN, read at once.
    t.setInterfaces({ en0: nic('10.0.0.7'), utun4: nic('203.0.113.7') })
    t.direct.checkAddresses()
    const withVpn = [...moved, { host: '203.0.113.7', port }]
    // The owner added an address of their own, which comes first.
    const own = { host: 'studio.example.com', port: 7000 }
    await t.direct.apply(on([own], 0))
    expect(t.listening().port).toBe(port)
    // An unchanged check sends nothing.
    t.direct.checkAddresses()
    await expect
      .poll(() => device.addresses.map((message) => message.addresses))
      .toEqual([moved, withVpn, [own, ...withVpn]])
  })

  it('cut the connections the limits hold back, and count them as refused', async () => {
    const t = await setup()
    await t.direct.apply(on())
    const { port } = t.listening()
    const admitted: Socket[] = []
    for (let i = 0; i < SOURCE_BURST; i++) admitted.push(await rawSocket(port))
    const limited = await rawSocket(port)
    await new Promise<void>((resolve) => limited.once('close', () => resolve()))
    expect(t.server.refused).toBe(1)
    expect(admitted.every((socket) => !socket.destroyed)).toBe(true)
    // The paired device is held back too until the source's bucket refills.
    await expect(t.connectPhone(port).then((device) => device.closing)).resolves.toBeNull()
    expect(t.server.refused).toBe(2)
  })
})
