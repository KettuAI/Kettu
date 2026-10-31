// The remote host's side of device connections, against an in-process agent host running the
// fake agent: handshake, hello and welcome, the session passed through, and what ends it.

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PortChannel } from '@shared/port-channel'
import { generateKeyPair, type KeyPair } from '@shared/remote/noise'
import { startTestHost, type TestHost } from '../agent-host/testing/harness'
import { DeviceStore } from './devices'
import { RemoteServer } from './server'
import { connectDevice, type TestDeviceOptions } from './testing/device'
import { memoryPorts, memoryTransports } from './testing/memory'

const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')

let agent: TestHost | null = null

afterEach(async () => {
  await agent?.stop()
  agent = null
})

async function setup(options: { agentDown?: boolean; helloTimeoutMs?: number } = {}) {
  agent = await startTestHost()
  const logs: string[] = []
  const devices = await DeviceStore.load(agent.dir, (level, message) =>
    logs.push(`${level}: ${message}`),
  )
  const hostKey = await generateKeyPair()
  const phoneKey = await generateKeyPair()
  const phone = (await devices.add({
    publicKey: base64(phoneKey.publicKey),
    name: 'Phone',
    kind: 'ios',
    platform: 'ios',
  }))!
  // What reached the agent host, and whether its port was closed.
  const forwarded: unknown[] = []
  const agentPorts: { closed: boolean }[] = []
  let changes = 0
  const host = agent.host
  const server = new RemoteServer({
    staticKey: hostKey,
    devices,
    host: { name: 'Studio', platform: process.platform, version: '0.0.0-test' },
    openAgentPort: async (device) => {
      if (options.agentDown) return null
      const [remoteEnd, agentEnd] = memoryPorts()
      const record = { closed: false }
      agentPorts.push(record)
      agentEnd.onClose(() => (record.closed = true))
      const recording: PortChannel = {
        ...agentEnd,
        onMessage: (listener) =>
          agentEnd.onMessage((data) => {
            forwarded.push(data)
            listener(data)
          }),
      }
      host.connect(recording as Parameters<typeof host.connect>[0], device)
      return remoteEnd
    },
    changed: () => changes++,
    log: (level, message) => logs.push(`${level}: ${message}`),
    ...(options.helloTimeoutMs ? { helloTimeoutMs: options.helloTimeoutMs } : {}),
  })
  const connect = (
    key: KeyPair = phoneKey,
    hello?: TestDeviceOptions['hello'],
  ): ReturnType<typeof connectDevice> => {
    const [deviceEnd, hostEnd] = memoryTransports()
    server.accept(hostEnd)
    return connectDevice({ transport: deviceEnd, hostKey: hostKey.publicKey, key, hello })
  }
  return {
    agent,
    server,
    devices,
    phone,
    logs,
    forwarded,
    agentPorts,
    connect,
    changes: () => changes,
  }
}

describe('a paired device', () => {
  it('is welcomed and runs a session with the fake agent, its events coming back', async () => {
    const t = await setup()
    const device = await t.connect()
    expect(await device.first).toEqual({
      type: 'welcome',
      protocol: 1,
      host: { name: 'Studio', platform: process.platform, version: '0.0.0-test' },
      features: [],
      role: 'owner',
      terminal: false,
      addresses: [],
    })
    expect(t.server.online()).toEqual([t.phone.id])
    expect(t.devices.get(t.phone.id)!.lastConnectedAt).not.toBeNull()

    const session = await device.port.request('sessions.create', {
      agentId: 'fake-agent',
      projectPath: t.agent.project,
    })
    await device.port.open(session.id)
    await device.port.request('sessions.prompt', {
      sessionId: session.id,
      content: [{ type: 'text', text: 'hello' }],
    })
    await device.port.untilEntry(session.id, (entry) => entry.kind === 'turn_end')
    const entries = device.port.entries(session.id)
    expect(entries.some((entry) => entry.kind === 'agent' && entry.markdown.length > 0)).toBe(true)
    expect(device.port.replicas.get(session.id)!.batches).toBeGreaterThan(1)
    expect(device.port.summary(session.id)).toMatchObject({ id: session.id, agentId: 'fake-agent' })
    // The requests reached the agent host as the device sent them.
    expect(t.forwarded).toContainEqual(
      expect.objectContaining({ type: 'request', method: 'sessions.create' }),
    )
  })

  it('is refused what needs main before the request reaches the agent host', async () => {
    const t = await setup()
    const device = await t.connect()
    await device.first
    await expect(
      device.port.request('projects.add', { path: t.agent.project }),
    ).rejects.toMatchObject({ code: 'forbidden' })
    await expect(
      device.port.request('attachments.add', { source: { grantId: 'grant' }, thumb: null }),
    ).rejects.toMatchObject({ code: 'forbidden' })
    expect(await device.port.request('projects.list', undefined)).toEqual([])
    const methods = t.forwarded.map((message) => (message as { method: string }).method)
    expect(methods).toEqual(['projects.list'])
    expect(t.logs).toEqual([
      `warn: Device ${t.phone.id} asked for projects.add, which devices may not call`,
      `warn: Device ${t.phone.id} asked for attachments.add, which devices may not call`,
    ])
  })

  it('has its sessions closed at once when it is removed, and is refused after', async () => {
    const t = await setup()
    const device = await t.connect()
    await device.first
    await device.port.request('agents.list', undefined)
    expect(await t.server.removeDevice(t.phone.id)).toBe(true)
    expect(await device.closing).toEqual({ type: 'closing', reason: 'removed' })
    await expect.poll(() => t.agentPorts[0]!.closed).toBe(true)
    expect(t.server.online()).toEqual([])
    expect(t.devices.list()).toEqual([])
    const file = JSON.parse(
      await readFile(path.join(t.agent.dir, 'remote', 'devices.json'), 'utf8'),
    )
    expect(file.devices).toEqual([])

    const again = await t.connect()
    expect(await again.closing).toBeNull()
    expect(t.server.refused).toBe(1)
  })

  it('hears why when the host stops', async () => {
    const t = await setup()
    const device = await t.connect()
    await device.first
    await t.server.stop('remote_off')
    expect(await device.closing).toEqual({ type: 'closing', reason: 'remote_off' })
    await expect.poll(() => t.agentPorts[0]!.closed).toBe(true)
  })

  it('is told the direct addresses in its welcome, and again when they change', async () => {
    const t = await setup()
    const home = { host: '192.168.1.20', port: 50123 }
    t.server.setAddresses([home])
    const device = await t.connect()
    expect(await device.first).toMatchObject({ type: 'welcome', addresses: [home] })
    t.server.setAddresses([{ ...home }])
    const vpn = { host: '100.100.1.2', port: 50123 }
    t.server.setAddresses([home, vpn])
    t.server.setAddresses([])
    await expect
      .poll(() => device.addresses)
      .toEqual([
        { type: 'addresses', addresses: [home, vpn] },
        { type: 'addresses', addresses: [] },
      ])
    // A device not yet welcomed hears them only in its welcome.
    const later = await t.connect()
    expect(await later.first).toMatchObject({ addresses: [] })
    expect(later.addresses).toEqual([])
  })

  it('hears that the host cannot run sessions while its agent host is down', async () => {
    const t = await setup({ agentDown: true })
    const device = await t.connect()
    expect(await device.first).toEqual({ type: 'closing', reason: 'unavailable' })
    expect(await device.closing).toEqual({ type: 'closing', reason: 'unavailable' })
  })
})

describe('the handshake', () => {
  it('refuses a key the host does not know at the first message, only counting it', async () => {
    const t = await setup()
    const stranger = await generateKeyPair()
    const device = await t.connect(stranger)
    expect(await device.closing).toBeNull()
    expect(t.server.refused).toBe(1)
    expect(t.changes()).toBe(1)
    expect(t.agentPorts).toEqual([])
    expect(t.logs).toEqual([])
  })

  it('refuses a first message that is not a handshake', async () => {
    const t = await setup()
    const [deviceEnd, hostEnd] = memoryTransports()
    t.server.accept(hostEnd)
    const closed = new Promise<void>((resolve) => deviceEnd.onClose(resolve))
    deviceEnd.send(new Uint8Array(96))
    await closed
    expect(t.server.refused).toBe(1)
  })

  it('closes a connection that says no hello in time', async () => {
    const t = await setup({ helloTimeoutMs: 50 })
    const device = await t.connect(undefined, null)
    expect(await device.closing).toBeNull()
    expect(t.agentPorts).toEqual([])
  })
})

describe('hello and welcome', () => {
  it('agrees on the newest version both sides speak', async () => {
    const t = await setup()
    const device = await t.connect(undefined, { protocol: { min: 1, max: 7 } })
    expect(await device.first).toMatchObject({ type: 'welcome', protocol: 1 })
  })

  it('says to update the host when the device speaks only newer versions, then closes', async () => {
    const t = await setup()
    const device = await t.connect(undefined, { protocol: { min: 2, max: 3 } })
    expect(await device.first).toEqual({ type: 'closing', reason: 'update_host' })
    expect(await device.closing).toEqual({ type: 'closing', reason: 'update_host' })
    expect(t.agentPorts).toEqual([])
  })

  it('closes on a hello that is not one', async () => {
    const t = await setup()
    const device = await t.connect(undefined, { client: { kind: 'ios' } })
    expect(await device.first).toEqual({ type: 'closing', reason: 'invalid' })
  })

  it('ignores fields it does not know', async () => {
    const t = await setup()
    const device = await t.connect(undefined, { resume: 'token', model: 'iPhone' })
    expect(await device.first).toMatchObject({ type: 'welcome' })
  })
})

describe('refusals', () => {
  it('update the status at once, then at most once a second', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'kettu-refusals-'))
    let changes = 0
    const server = new RemoteServer({
      staticKey: await generateKeyPair(),
      devices: await DeviceStore.load(dir, () => {}),
      host: { name: 'Studio', platform: process.platform, version: '0.0.0-test' },
      openAgentPort: async () => null,
      changed: () => changes++,
      log: () => {},
    })
    vi.useFakeTimers()
    try {
      for (let i = 0; i < 50; i++) server.refusedOne()
      expect(server.refused).toBe(50)
      expect(changes).toBe(1)
      vi.advanceTimersByTime(999)
      expect(changes).toBe(1)
      vi.advanceTimersByTime(1)
      expect(changes).toBe(2)
      // Nothing new to report, so the next second stays quiet.
      vi.advanceTimersByTime(5_000)
      expect(changes).toBe(2)
      server.refusedOne()
      expect(changes).toBe(3)
      server.refusedOne()
      await server.stop('stopping')
      vi.advanceTimersByTime(5_000)
      expect(changes).toBe(3)
      expect(server.refused).toBe(52)
    } finally {
      vi.useRealTimers()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
