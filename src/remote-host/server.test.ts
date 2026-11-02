// The remote host's side of device connections, against an in-process agent host running the
// fake agent: handshake, pairing, hello and welcome, the session passed through, and what ends it.

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostMethod } from '@shared/agent-host'
import type { PortChannel } from '@shared/port-channel'
import { deviceId } from '@shared/remote/device'
import type { HostAdminEvent } from '@shared/remote/host-admin'
import { generateKeyPair, type KeyPair } from '@shared/remote/noise'
import { parsePairingLink, type PairingState } from '@shared/remote/pairing'
import { PROTOCOL_VERSION } from '@shared/remote/protocol'
import { startTestHost, type TestHost } from '../agent-host/testing/harness'
import { ActivityLog } from './activity'
import { DeviceStore } from './devices'
import { PairingCodes } from './pairing'
import { RemoteServer, type RemoteServerOptions } from './server'
import { connectDevice, type TestDevice, type TestDeviceOptions } from './testing/device'
import { memoryPorts, memoryTransports } from './testing/memory'

const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')

let agent: TestHost | null = null
const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  await agent?.stop()
  agent = null
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

const DAY = 24 * 60 * 60 * 1000

async function setup(
  options: {
    agentDown?: boolean
    helloTimeoutMs?: number
    ttlMs?: number
    now?: () => number
    admin?: RemoteServerOptions['admin']
  } = {},
) {
  agent = await startTestHost()
  const logs: string[] = []
  const log = (level: string, message: string) => logs.push(`${level}: ${message}`)
  const devices = await DeviceStore.load(agent.dir, log, options.now)
  const activity = await ActivityLog.load(agent.dir, log, options.now)
  const hostKey = await generateKeyPair()
  const phoneKey = await generateKeyPair()
  const phone = (await devices.add({
    publicKey: base64(phoneKey.publicKey),
    name: 'Phone',
    kind: 'ios',
    platform: 'ios',
    model: 'iPhone 17 Pro',
  }))!
  // What each asker heard of its code, by code id.
  const heard = new Map<number, PairingState[]>()
  const pairing = new PairingCodes({
    hostKey: hostKey.publicKey,
    addresses: () => [{ host: '192.168.1.8', port: 47821 }],
    send: (codeId, state) => heard.set(codeId, [...(heard.get(codeId) ?? []), state]),
    ...(options.ttlMs ? { ttlMs: options.ttlMs } : {}),
  })
  // What reached the agent host, and whether its port was closed.
  const forwarded: unknown[] = []
  const agentPorts: { closed: boolean }[] = []
  let changes = 0
  const host = agent.host
  const server = new RemoteServer({
    staticKey: hostKey,
    devices,
    activity,
    pairing,
    host: { name: 'Studio', platform: process.platform, version: '0.0.0-test' },
    uploads: path.join(agent.dir, 'remote', 'uploads'),
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
    log,
    ...(options.admin ? { admin: options.admin } : {}),
    ...(options.helloTimeoutMs ? { helloTimeoutMs: options.helloTimeoutMs } : {}),
    ...(options.now ? { now: options.now } : {}),
  })
  const connect = (
    key: KeyPair = phoneKey,
    hello?: TestDeviceOptions['hello'],
    psk?: Uint8Array,
  ): ReturnType<typeof connectDevice> => {
    const [deviceEnd, hostEnd] = memoryTransports()
    server.accept(hostEnd)
    return connectDevice({ transport: deviceEnd, hostKey: hostKey.publicKey, key, hello, psk })
  }
  /** Opens a code for the asker `codeId` and reads its secret off the link. */
  const openCode = (codeId = 1): Uint8Array => {
    pairing.open(codeId)
    const waiting = heard.get(codeId)!.at(-1)!
    if (waiting.state !== 'waiting') throw new Error('The code is not waiting')
    const payload = parsePairingLink(waiting.link)!
    expect(payload.hostKey).toEqual(hostKey.publicKey)
    expect(payload.addresses).toEqual([{ host: '192.168.1.8', port: 47821 }])
    return payload.secret
  }
  /** Pairs a device with the secret, as an iPad saying hello with its name and model. */
  const pairWith = (secret: Uint8Array, key: KeyPair, name = 'iPad Air') =>
    connect(
      key,
      {
        client: { kind: 'ios', version: '1.0.0', platform: 'iPadOS 26.1' },
        device: { name, model: 'iPad Air' },
      },
      secret,
    )
  const states = (codeId = 1) => (heard.get(codeId) ?? []).map((state) => state.state)
  const until = async (codeId: number, state: PairingState['state']) => {
    await expect.poll(() => states(codeId).at(-1)).toBe(state)
    return heard.get(codeId)!.at(-1)!
  }
  return {
    agent,
    server,
    devices,
    activity,
    pairing,
    phone,
    phoneKey,
    logs,
    forwarded,
    agentPorts,
    connect,
    openCode,
    pairWith,
    states,
    until,
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
      features: ['bytes'],
      role: 'owner',
      device: { id: t.phone.id, name: 'Phone' },
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
      device.port.request('media.open', {
        projectPath: t.agent.project,
        path: 'a.png',
        sessionId: 'none',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' })
    await expect(
      device.port.request('attachments.add', { source: { grantId: 'grant' }, thumb: null }),
    ).rejects.toMatchObject({ code: 'forbidden' })
    expect(await device.port.request('projects.list', undefined)).toEqual([])
    const methods = t.forwarded.map((message) => (message as { method: string }).method)
    expect(methods).toEqual(['projects.list'])
    expect(t.logs).toEqual([
      `warn: Device ${t.phone.id} asked for media.open, which devices may not call`,
      `warn: Device ${t.phone.id} asked for attachments.add, which devices may not call`,
    ])
  })

  it('adds a project by the folder it names', async () => {
    const t = await setup()
    const device = await t.connect()
    await device.first
    expect(await device.port.request('projects.add', { path: t.agent.project })).toMatchObject({
      path: t.agent.project,
    })
    await expect(
      device.port.request('projects.add', { path: path.join(t.agent.dir, 'missing') }),
    ).rejects.toMatchObject({ code: 'invalid_params' })
  })

  it('has its sessions closed at once when it is removed, and hears why when it comes back', async () => {
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
    expect(await again.first).toEqual({ type: 'closing', reason: 'removed' })
    expect(await again.closing).toEqual({ type: 'closing', reason: 'removed' })
    expect(t.server.refused).toBe(0)
    expect(t.agentPorts).toHaveLength(1)
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

  it('lets a removed device finish it and tells it why after its hello, not counting it', async () => {
    const t = await setup()
    await t.server.removeDevice(t.phone.id)
    const changes = t.changes()
    const device = await t.connect()
    expect(await device.first).toEqual({ type: 'closing', reason: 'removed' })
    expect(await device.closing).toEqual({ type: 'closing', reason: 'removed' })
    expect(t.server.refused).toBe(0)
    expect(t.changes()).toBe(changes)
    expect(t.agentPorts).toEqual([])
    expect(t.server.online()).toEqual([])
    expect(t.logs).toEqual([`info: Told device ${t.phone.id} that it was removed`])
    expect(t.activity.list(t.phone.id).map((event) => event.kind)).toEqual(['removed'])

    // A stranger is still dropped at its first message, and only counted.
    const stranger = await t.connect(await generateKeyPair())
    expect(await stranger.closing).toBeNull()
    expect(t.server.refused).toBe(1)
    expect(t.logs).toHaveLength(1)
  })

  it('tells a removed device nothing before its hello', async () => {
    const t = await setup({ helloTimeoutMs: 50 })
    await t.server.removeDevice(t.phone.id)
    const device = await t.connect(undefined, null)
    expect(await device.closing).toBeNull()
    expect(t.server.refused).toBe(0)
    expect(t.logs).toEqual([])
  })

  it('welcomes a removed device paired again between its handshake and its hello', async () => {
    const t = await setup()
    await t.server.removeDevice(t.phone.id)
    const device = await t.connect(undefined, null)
    expect(await device.answered).toBe(true)
    await t.devices.add({
      publicKey: base64(t.phoneKey.publicKey),
      name: 'Phone',
      kind: 'ios',
      platform: 'ios',
      model: 'iPhone 17 Pro',
    })
    await device.send({
      type: 'hello',
      protocol: { min: PROTOCOL_VERSION, max: PROTOCOL_VERSION },
      client: { kind: 'ios', version: '1.0.0', platform: 'ios' },
    })
    expect(await device.first).toMatchObject({ type: 'welcome', device: { id: t.phone.id } })
    expect(t.server.online()).toEqual([t.phone.id])
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
    expect(await device.first).toMatchObject({ type: 'welcome', protocol: PROTOCOL_VERSION })
  })

  it('says to update the host when the device speaks only newer versions, then closes', async () => {
    const t = await setup()
    const newer = { min: PROTOCOL_VERSION + 1, max: PROTOCOL_VERSION + 2 }
    const device = await t.connect(undefined, { protocol: newer })
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
    const staticKey = await generateKeyPair()
    const server = new RemoteServer({
      staticKey,
      devices: await DeviceStore.load(dir, () => {}),
      activity: await ActivityLog.load(dir, () => {}),
      pairing: new PairingCodes({
        hostKey: staticKey.publicKey,
        addresses: () => [],
        send: () => {},
      }),
      host: { name: 'Studio', platform: process.platform, version: '0.0.0-test' },
      uploads: path.join(dir, 'uploads'),
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
describe('pairing', () => {
  it('adds a device whose secret checks out once the asker agrees, and runs its session', async () => {
    const t = await setup()
    const secret = t.openCode()
    const padKey = await generateKeyPair()
    const pad = await t.pairWith(secret, padKey)
    const asked = await t.until(1, 'confirm')
    expect(asked).toEqual({
      state: 'confirm',
      device: {
        name: 'iPad Air',
        model: 'iPad Air',
        kind: 'ios',
        platform: 'iPadOS 26.1',
        known: false,
      },
    })
    // Nothing is added before the answer.
    expect(t.devices.list()).toHaveLength(1)
    t.pairing.answer(1, { add: true, name: 'My iPad' })

    const id = await deviceId(padKey.publicKey)
    expect(await pad.first).toMatchObject({ type: 'welcome', device: { id, name: 'My iPad' } })
    expect(await t.until(1, 'added')).toMatchObject({
      state: 'added',
      device: { id, name: 'My iPad', model: 'iPad Air', kind: 'ios', platform: 'iPadOS 26.1' },
    })
    expect(t.devices.get(id)).toMatchObject({ name: 'My iPad', model: 'iPad Air' })
    expect(t.server.online()).toEqual([id])
    // The code paired its one device.
    expect(t.pairing.current()).toBeNull()

    const session = await pad.port.request('sessions.create', {
      agentId: 'fake-agent',
      projectPath: t.agent.project,
    })
    await expect
      .poll(() => t.activity.list(id).map((event) => event.kind))
      .toEqual(['session-created', 'connected', 'paired'])
    expect(t.activity.list(id)[0]).toMatchObject({ sessionId: session.id })

    // Once added, the device connects as any paired device does.
    pad.close()
    const again = await t.connect(padKey)
    expect(await again.first).toMatchObject({ type: 'welcome', device: { id } })
  })

  it('counts a wrong secret as one attempt, and the fifth voids the code', async () => {
    const t = await setup()
    const secret = t.openCode()
    for (let i = 0; i < 5; i++) {
      const wrong = crypto.getRandomValues(new Uint8Array(32))
      const device = await t.pairWith(wrong, await generateKeyPair())
      expect(await device.closing).toBeNull()
    }
    expect(await t.until(1, 'void')).toEqual({ state: 'void', reason: 'attempts' })
    expect(t.server.refused).toBe(5)
    const late = await t.pairWith(secret, await generateKeyPair())
    expect(await late.closing).toBeNull()
    expect(t.devices.list()).toHaveLength(1)
  })

  it('takes no attempt for a handshake from a key the host does not know', async () => {
    const t = await setup()
    const secret = t.openCode()
    for (let i = 0; i < 6; i++) {
      const stranger = await t.connect(await generateKeyPair())
      expect(await stranger.closing).toBeNull()
    }
    expect(t.server.refused).toBe(6)
    const pad = await t.pairWith(secret, await generateKeyPair())
    await t.until(1, 'confirm')
    pad.close()
  })

  it('voids the code after five minutes', async () => {
    const t = await setup({ ttlMs: 50 })
    const secret = t.openCode()
    expect(await t.until(1, 'void')).toEqual({ state: 'void', reason: 'expired' })
    const late = await t.pairWith(secret, await generateKeyPair())
    expect(await late.closing).toBeNull()
  })

  it('voids the code when Add device closes, or another opens', async () => {
    const t = await setup()
    const first = t.openCode(1)
    const second = t.openCode(2)
    expect(await t.until(1, 'void')).toEqual({ state: 'void', reason: 'replaced' })
    expect(t.states(2)).toEqual(['waiting'])
    const replaced = await t.pairWith(first, await generateKeyPair())
    expect(await replaced.closing).toBeNull()
    t.pairing.close(2)
    expect(await t.until(2, 'void')).toEqual({ state: 'void', reason: 'closed' })
    const closed = await t.pairWith(second, await generateKeyPair())
    expect(await closed.closing).toBeNull()
  })

  it('closes the device the asker rejects, with the reason, and voids the code', async () => {
    const t = await setup()
    const secret = t.openCode()
    const pad = await t.pairWith(secret, await generateKeyPair())
    await t.until(1, 'confirm')
    t.pairing.answer(1, { add: false, name: 'iPad Air' })
    expect(await pad.first).toEqual({ type: 'closing', reason: 'rejected' })
    expect(await t.until(1, 'void')).toEqual({ state: 'void', reason: 'rejected' })
    expect(t.devices.list()).toHaveLength(1)
    const again = await t.pairWith(secret, await generateKeyPair())
    expect(await again.closing).toBeNull()
  })

  it('gives the code back when the device leaves before the answer', async () => {
    const t = await setup()
    const secret = t.openCode()
    const pad = await t.pairWith(secret, await generateKeyPair())
    await t.until(1, 'confirm')
    pad.close()
    expect(await t.until(1, 'waiting')).toMatchObject({ state: 'waiting' })
    const next = await t.pairWith(secret, await generateKeyPair(), 'Other iPad')
    expect(await t.until(1, 'confirm')).toMatchObject({ device: { name: 'Other iPad' } })
    next.close()
  })

  it('pairs a known key again, replacing its entry', async () => {
    const t = await setup()
    const secret = t.openCode()
    const phone = await t.pairWith(secret, t.phoneKey, 'Phone again')
    expect(await t.until(1, 'confirm')).toMatchObject({ device: { known: true } })
    t.pairing.answer(1, { add: true, name: 'Phone again' })
    expect(await phone.first).toMatchObject({ type: 'welcome', device: { id: t.phone.id } })
    expect(t.devices.list()).toEqual([
      expect.objectContaining({ id: t.phone.id, name: 'Phone again', model: 'iPad Air' }),
    ])
  })

  it('pairs a removed device again, which then connects as any paired device does', async () => {
    const t = await setup()
    await t.server.removeDevice(t.phone.id)
    const secret = t.openCode()
    const phone = await t.pairWith(secret, t.phoneKey, 'Phone again')
    expect(await t.until(1, 'confirm')).toMatchObject({ device: { known: false } })
    t.pairing.answer(1, { add: true, name: 'Phone again' })
    expect(await phone.first).toMatchObject({ type: 'welcome', device: { id: t.phone.id } })
    phone.close()
    const again = await t.connect()
    expect(await again.first).toMatchObject({ type: 'welcome', device: { id: t.phone.id } })
    expect(t.logs).toEqual([])
  })

  it('closes a pairing device whose hello has no name, spending an attempt', async () => {
    const t = await setup()
    const secret = t.openCode()
    for (let i = 0; i < 5; i++) {
      const device = await t.connect(await generateKeyPair(), undefined, secret)
      expect(await device.first).toEqual({ type: 'closing', reason: 'invalid' })
    }
    expect(await t.until(1, 'void')).toEqual({ state: 'void', reason: 'attempts' })
  })
})

describe('a device name', () => {
  it('changes from the owner and from the device, each telling the device', async () => {
    const t = await setup()
    const device = await t.connect()
    await device.first
    expect(await t.server.renameDevice(t.phone.id, '  Work phone ', 'owner')).toMatchObject({
      name: 'Work phone',
    })
    await expect.poll(() => device.notices).toEqual([{ type: 'renamed', name: 'Work phone' }])

    await device.send({ type: 'rename', name: 'Pocket' })
    await expect.poll(() => t.devices.get(t.phone.id)?.name).toBe('Pocket')
    await expect.poll(() => device.notices).toHaveLength(2)
    expect(device.notices[1]).toEqual({ type: 'renamed', name: 'Pocket' })
    expect(
      t.activity
        .list(t.phone.id)
        .filter((event) => event.kind === 'renamed')
        .map((event) => event.kind === 'renamed' && [event.from, event.to, event.by]),
    ).toEqual([
      ['Work phone', 'Pocket', 'device'],
      ['Phone', 'Work phone', 'owner'],
    ])
    // A rename does not reach the agent host.
    expect(t.forwarded).toEqual([])
  })

  it('stays when the new one is empty once cleaned up', async () => {
    const t = await setup()
    expect(await t.server.renameDevice(t.phone.id, ' \n ', 'owner')).toBeNull()
    expect(t.devices.get(t.phone.id)?.name).toBe('Phone')
  })
})

describe('devices not seen for 90 days', () => {
  it('are removed, unless a session is open', async () => {
    let now = Date.now()
    const t = await setup({ now: () => now })
    const tabletKey = await generateKeyPair()
    const tablet = (await t.devices.add({
      publicKey: base64(tabletKey.publicKey),
      name: 'Tablet',
      kind: 'ios',
      platform: 'iPadOS 26.1',
      model: 'iPad Air',
    }))!
    const phone = await t.connect()
    await phone.first
    now += 90 * DAY - 1
    await t.server.sweep()
    expect(t.devices.list()).toHaveLength(2)
    now += 1
    await t.server.sweep()
    // The phone is online, so it was seen.
    expect(t.devices.list().map((device) => device.id)).toEqual([t.phone.id])
    expect(t.activity.list(tablet.id)[0]).toMatchObject({ kind: 'removed', by: 'unseen' })
    const back = await t.connect(tabletKey)
    expect(await back.first).toEqual({ type: 'closing', reason: 'removed' })
  })

  it('are looked for every hour', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    try {
      const t = await setup()
      t.server.startSweeping()
      await vi.advanceTimersByTimeAsync(90 * DAY + 60 * 60 * 1000)
      expect(t.devices.list()).toEqual([])
      await t.server.stop('stopping')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('reset', () => {
  it('removes every device, closing its sessions, and voids the code', async () => {
    const t = await setup()
    const device = await t.connect()
    await device.first
    t.openCode()
    await t.server.reset()
    expect(await device.closing).toEqual({ type: 'closing', reason: 'removed' })
    expect(t.devices.list()).toEqual([])
    expect(t.states()).toEqual(['waiting', 'void'])
    expect(t.activity.list(t.phone.id)[0]).toMatchObject({ kind: 'removed', by: 'reset' })
  })

  it('forgets the removed devices too, so each is dropped as a stranger after', async () => {
    const t = await setup()
    const tabletKey = await generateKeyPair()
    const tablet = (await t.devices.add({
      publicKey: base64(tabletKey.publicKey),
      name: 'Tablet',
      kind: 'ios',
      platform: 'iPadOS 26.1',
      model: 'iPad Air',
    }))!
    await t.server.removeDevice(tablet.id)
    await t.server.reset()
    for (const key of [t.phoneKey, tabletKey]) {
      const device = await t.connect(key)
      expect(await device.closing).toBeNull()
    }
    expect(t.server.refused).toBe(2)
    expect(t.logs).toEqual([])
    const file = JSON.parse(
      await readFile(path.join(t.agent.dir, 'remote', 'devices.json'), 'utf8'),
    )
    expect(file).toEqual({ version: 1, devices: [], removed: [] })
  })
})

describe("a device's activity", () => {
  it('names a session by the title it had at the time', async () => {
    const t = await setup()
    const device = await t.connect()
    await device.first
    const session = await device.port.request('sessions.create', {
      agentId: 'fake-agent',
      projectPath: t.agent.project,
    })
    const rename = async (title: string): Promise<void> => {
      await device.port.request('sessions.rename', { sessionId: session.id, title })
      await expect.poll(() => device.port.summary(session.id)?.title).toBe(title)
    }
    await rename('Fix the login')
    await device.port.request('sessions.archive', { sessionId: session.id })
    await rename('Login, done')
    await device.port.request('sessions.delete', { sessionId: session.id })
    const sessions = () =>
      t.activity
        .list(t.phone.id)
        .flatMap((event) => ('sessionId' in event ? [[event.kind, event.title]] : []))
    await expect.poll(sessions).toEqual([
      ['session-deleted', 'Login, done'],
      ['session-archived', 'Fix the login'],
      ['session-created', null],
    ])
  })

  it('logs no new connection for a device back within minutes', async () => {
    const t = await setup()
    const first = await t.connect()
    await first.first
    first.close()
    await expect.poll(() => t.server.online()).toEqual([])
    const again = await t.connect()
    await again.first
    expect(t.activity.list(t.phone.id).map((event) => event.kind)).toEqual(['connected'])
  })
})

/** A device's call of the host's parent, which the test port only knows the agent host's way. */
function call(device: TestDevice) {
  return (method: string, params?: unknown): Promise<unknown> =>
    device.port.request(method as HostMethod, params as never)
}

describe("an owner's calls beyond its sessions", () => {
  it("reach the host's parent with the device's id, and its answers come back", async () => {
    const asked: { deviceId: string; method: string; params: unknown }[] = []
    const t = await setup({
      admin: async (deviceId, method, params) => {
        asked.push({ deviceId, method, params })
        return method === 'settings.get'
          ? { result: { git: { backgroundFetch: true } } }
          : { error: { code: 'invalid_params', message: 'A device keeps these settings itself' } }
      },
    })
    const device = await t.connect()
    await device.first
    const admin = call(device)
    expect(await admin('settings.get')).toEqual({ git: { backgroundFetch: true } })
    await expect(
      admin('settings.update', { patch: { appearance: { theme: 'dark' } } }),
    ).rejects.toMatchObject({
      code: 'invalid_params',
      message: 'A device keeps these settings itself',
    })
    expect(asked).toEqual([
      { deviceId: t.phone.id, method: 'settings.get', params: undefined },
      {
        deviceId: t.phone.id,
        method: 'settings.update',
        params: { patch: { appearance: { theme: 'dark' } } },
      },
    ])
    // Neither reached the agent host, which still takes the rest.
    expect(await device.port.request('projects.list', undefined)).toEqual([])
    const methods = t.forwarded.map((message) => (message as { method: string }).method)
    expect(methods).toEqual(['projects.list'])
  })

  it('are refused while nothing answers them', async () => {
    const t = await setup()
    const device = await t.connect()
    await device.first
    await expect(call(device)('host.info')).rejects.toMatchObject({ code: 'forbidden' })
    expect(t.forwarded).toEqual([])
    expect(t.logs).toEqual([
      `warn: Device ${t.phone.id} asked for host.info, which it may not call`,
    ])
  })

  it("answer a parent that fails with the host's own error", async () => {
    const t = await setup({ admin: () => Promise.reject(new Error('gone')) })
    const device = await t.connect()
    await device.first
    await expect(call(device)('host.info')).rejects.toMatchObject({ code: 'internal' })
  })
})

describe("the host's events", () => {
  it('reach every owner device that is welcomed, or the one they are for', async () => {
    const t = await setup({ admin: async () => ({ result: null }) })
    const tabletKey = await generateKeyPair()
    const tablet = (await t.devices.add({
      publicKey: base64(tabletKey.publicKey),
      name: 'Tablet',
      kind: 'ios',
      platform: 'ios',
      model: 'iPad Air',
    }))!
    const phone = await t.connect()
    const pad = await t.connect(tabletKey)
    await Promise.all([phone.first, pad.first])
    const changed: HostAdminEvent = {
      type: 'remote.changed',
      status: {
        state: 'on',
        hostName: 'Studio',
        systemName: 'studio',
        devices: [],
        online: [],
        plainTextKey: false,
        direct: { state: 'off' },
      },
    }
    const pairing: HostAdminEvent = {
      type: 'remote.pairing',
      event: { codeId: 1, pairing: { state: 'void', reason: 'closed' } },
    }
    t.server.adminEvent(changed, null)
    t.server.adminEvent(pairing, tablet.id)
    await expect.poll(() => pad.port.events).toEqual([changed, pairing])
    await expect.poll(() => phone.port.events).toEqual([changed])
  })
})

describe("a desktop app's browser", () => {
  /** A dev server on this host's loopback, which answers every request with `body`. */
  async function devServer(body: string): Promise<number> {
    const server = net.createServer((socket) => {
      socket.once('data', () => socket.end(`HTTP/1.0 200 OK\r\n\r\n${body}`))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
    return (server.address() as net.AddressInfo).port
  }

  it('opens a dev server here through a forward the agent host granted', async () => {
    const t = await setup()
    const app = await t.connect(undefined, {
      client: { kind: 'desktop', version: '1.0.0', platform: 'macOS 26.1' },
      features: ['browser'],
    })
    await app.first
    const created = await app.port.request('sessions.create', {
      agentId: 'fake-agent',
      projectPath: t.agent.project,
      prompt: [{ type: 'text', text: 'Open the app' }],
    })
    await app.port.untilStatus(created.id, 'ready')
    const devPort = await devServer('hello from the host')
    const answered = t.agent.host.browserCall({
      callId: 21,
      sessionId: created.id,
      tool: 'browser_navigate',
      args: { url: `http://127.0.0.1:${devPort}/` },
      projectPath: t.agent.project,
    })
    await app.port.until(() => app.port.events.some((event) => event.type === 'browser.call'))

    // A port the agent did not open stays shut; the granted one reaches the server.
    await app.send({
      type: 'forward.open',
      stream: 1,
      sessionId: created.id,
      host: '127.0.0.1',
      port: devPort + 1,
    })
    await expect.poll(() => app.cancels.map((cancel) => cancel.stream)).toEqual([1])
    expect(app.cancels[0]!.error).toMatchObject({ code: 'forbidden' })
    await app.send({
      type: 'forward.open',
      stream: 3,
      sessionId: created.id,
      host: '127.0.0.1',
      port: devPort,
    })
    await app.sendBytes(3, new TextEncoder().encode('GET / HTTP/1.0\r\n\r\n'))
    const response = new TextDecoder().decode(await app.download(3))
    expect(response).toBe('HTTP/1.0 200 OK\r\n\r\nhello from the host')

    await app.port.request('browser.answer', {
      callId: 21,
      answer: { result: { text: 'Opened the page.', value: {} } },
    })
    expect(await answered).toEqual({ result: { text: 'Opened the page.', value: {} } })

    // An id not above the last the device opened breaks the protocol.
    await app.send({
      type: 'forward.open',
      stream: 3,
      sessionId: created.id,
      host: '127.0.0.1',
      port: devPort,
    })
    expect(await app.closing).toEqual({ type: 'closing', reason: 'invalid' })
  })

  it('is not one a phone’s port serves', async () => {
    const t = await setup()
    const phone = await t.connect()
    await phone.first
    const created = await phone.port.request('sessions.create', {
      agentId: 'fake-agent',
      projectPath: t.agent.project,
      prompt: [{ type: 'text', text: 'Open the app' }],
    })
    await phone.port.untilStatus(created.id, 'ready')
    void t.agent.host.browserCall({
      callId: 22,
      sessionId: created.id,
      tool: 'browser_snapshot',
      args: {},
      projectPath: t.agent.project,
    })
    expect(t.agent.sent).toContainEqual(
      expect.objectContaining({ type: 'host:browser-call', callId: 22 }),
    )
    await expect(
      phone.port.request('browser.answer', {
        callId: 22,
        answer: { result: { text: 'no', value: {} } },
      }),
    ).rejects.toMatchObject({ code: 'forbidden' })
  })
})
