// The desktop app's side as a device of other hosts, against the real remote host in-process:
// pairing through IKpsk1 and the owner's answer, the welcome saving the host, reconnecting with IK,
// resuming the session the host kept, addresses, renames, removal and the timeout.

import http from 'node:http'
import { createServer, type AddressInfo } from 'node:net'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PortChannel } from '@shared/port-channel'
import { deviceId, type PortDevice } from '@shared/remote/device'
import { PAIR_HOST_TIMEOUT_MS, type HostPairingState } from '@shared/remote/hosts'
import type { KeepaliveTimings } from '@shared/remote/keepalive'
import { generateKeyPair, type KeyPair } from '@shared/remote/noise'
import { parsePairingLink, type PairingPayload, type PairingState } from '@shared/remote/pairing'
import type { DirectAddress } from '@shared/remote/protocol'
import type { Transport } from '@shared/remote/transport'
import { tempFolder } from '../agent-host/testing/temp'
import { ActivityLog } from './activity'
import { HostClient } from './client'
import { DeviceStore } from './devices'
import { connectTransport, DirectListener } from './direct'
import { HostStore } from './hosts'
import { PairingCodes } from './pairing'
import { RemoteServer } from './server'
import { clearUploads } from './uploads'
import {
  hangingTransports,
  memoryPorts,
  memoryTransports,
  type HangingTransports,
} from './testing/memory'

const STUDIO: DirectAddress = { host: '192.168.1.8', port: 47821 }
const NOWHERE: DirectAddress = { host: '192.0.2.1', port: 9 }
/** Behind a proxy that takes every connection and closes it once the device speaks. */
const PROXIED: DirectAddress = { host: '198.51.100.7', port: 47821 }
const quiet = (): void => {}

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/**
 * A host as the remote host runs it, whose agent host answers `ping` with `pong` and `echo` with
 * the bytes it was given.
 */
async function startHost(dir: string, hostKey: KeyPair, resumeMs?: number) {
  // The agent host's end of each device session's port, with the device it serves.
  const agentEnds: { device: PortDevice; port: PortChannel }[] = []
  const devices = await DeviceStore.load(dir, quiet)
  const activity = await ActivityLog.load(dir, quiet)
  const uploads = path.join(dir, 'remote', 'uploads')
  await clearUploads(uploads)
  const heard = new Map<number, PairingState[]>()
  const pairing = new PairingCodes({
    hostKey: hostKey.publicKey,
    addresses: () => [STUDIO],
    send: (codeId, state) => heard.set(codeId, [...(heard.get(codeId) ?? []), state]),
  })
  const server = new RemoteServer({
    staticKey: hostKey,
    devices,
    activity,
    pairing,
    host: { name: 'Studio', platform: 'linux', version: '0.2.0' },
    uploads,
    openAgentPort: async (device) => {
      const [remoteEnd, agentEnd] = memoryPorts()
      agentEnds.push({ device, port: agentEnd })
      agentEnd.onMessage((data) => {
        const { type, id, method, params } = data as {
          type: string
          id: number
          method: string
          params: { bytes?: ArrayBuffer }
        }
        if (type === 'request' && method === 'ping') {
          agentEnd.send({ type: 'response', id, result: 'pong' })
        }
        if (type === 'request' && method === 'echo') {
          const bytes = params.bytes
          agentEnd.send({ type: 'response', id, result: { got: bytes?.byteLength, bytes } })
        }
      })
      return remoteEnd
    },
    changed: quiet,
    log: quiet,
    ...(resumeMs ? { resumeMs } : {}),
  })
  const last = (codeId: number) => heard.get(codeId)?.at(-1)
  const until = async (codeId: number, state: PairingState['state']) => {
    await expect.poll(() => last(codeId)?.state).toBe(state)
    return last(codeId)!
  }
  /** A new code and what its link carries. */
  const openCode = (codeId = 1): PairingPayload => {
    pairing.open(codeId)
    const waiting = last(codeId)
    if (waiting?.state !== 'waiting') throw new Error('The code is not waiting')
    return parsePairingLink(waiting.link)!
  }
  cleanups.push(() => server.stop('stopping'))
  return { server, devices, pairing, openCode, until, agentEnds }
}

async function setup(
  options: {
    timeoutMs?: number
    retryMs?: number
    lateMs?: number
    resumeMs?: number
    keepalive?: KeepaliveTimings
  } = {},
) {
  const dir = await tempFolder('kettu-client-')
  const hostKey = await generateKeyPair()
  const deviceKey = await generateKeyPair()
  const host = await startHost(dir, hostKey, options.resumeMs)
  // Whether the host's address answers, and how many connections each address was asked for.
  let reachable = true
  const dialed: string[] = []
  // The host's end of each connection it took, to cut it, and the connection, to hang it.
  const hostEnds: Transport[] = []
  const wires: HangingTransports[] = []
  const connect = (address: DirectAddress, signal: AbortSignal): Promise<Transport> => {
    dialed.push(`${address.host}:${address.port}`)
    if (address.host === STUDIO.host && reachable) {
      const open = (): Transport => {
        const wire = hangingTransports()
        wires.push(wire)
        hostEnds.push(wire.host)
        host.server.accept(wire.host)
        return wire.device
      }
      if (!options.lateMs) return Promise.resolve(open())
      return new Promise((resolve) => setTimeout(() => resolve(open()), options.lateMs))
    }
    if (address.host === PROXIED.host) {
      const [deviceEnd, proxyEnd] = memoryTransports()
      proxyEnd.onMessage(() => proxyEnd.close())
      return Promise.resolve(deviceEnd)
    }
    // An address nothing answers at: the try waits until the dialing gives up.
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)))
  }
  const pairings = new Map<number, HostPairingState[]>()
  const mainPorts: PortChannel[] = []
  const closedPorts = new Set<PortChannel>()
  const store = await HostStore.load(dir, quiet)
  let changes = 0
  const makeClient = (hosts: HostStore): HostClient => {
    const client = new HostClient({
      key: deviceKey,
      hosts,
      client: { kind: 'desktop', version: '0.3.0', platform: 'macOS 26.1' },
      name: () => 'Lin MacBook',
      openMainPort: async () => {
        const [clientEnd, mainEnd] = memoryPorts()
        mainPorts.push(mainEnd)
        mainEnd.onClose(() => closedPorts.add(mainEnd))
        return clientEnd
      },
      changed: () => changes++,
      pairing: (pairId, state) => pairings.set(pairId, [...(pairings.get(pairId) ?? []), state]),
      log: quiet,
      connect,
      timeoutMs: options.timeoutMs ?? 2_000,
      retryDelay: () => options.retryMs ?? 20,
      ...(options.keepalive ? { keepalive: options.keepalive } : {}),
    })
    cleanups.push(() => client.stop())
    return client
  }
  const client = makeClient(store)
  client.start()
  const states = (pairId: number) => (pairings.get(pairId) ?? []).map((state) => state.state)
  const pairingEnd = async (pairId: number) => {
    await expect.poll(() => ['added', 'failed'].includes(states(pairId).at(-1) ?? '')).toBe(true)
    return pairings.get(pairId)!.at(-1)!
  }
  /** Pairs with a fresh code, the owner adding this computer under `name`. */
  const paired = async (name = 'Lin MacBook') => {
    const payload = host.openCode()
    client.pair(1, payload, 'MacBook Pro')
    await host.until(1, 'confirm')
    host.pairing.answer(1, { add: true, name })
    const added = await pairingEnd(1)
    if (added.state !== 'added') throw new Error(`Not added: ${JSON.stringify(added)}`)
    return added.host
  }
  const hostId = await deviceId(hostKey.publicKey)
  const connection = (id = hostId) => client.list().find((entry) => entry.id === id)?.connection
  return {
    dir,
    host,
    hostId,
    hostKey,
    deviceKey,
    client,
    store,
    makeClient,
    dialed,
    hostEnds,
    wires,
    mainPorts,
    closedPorts,
    states,
    pairingEnd,
    paired,
    connection,
    setReachable: (next: boolean) => (reachable = next),
    changes: () => changes,
  }
}

describe('pairing with a host', () => {
  it('waits for the owner, then keeps the host it was added to', async () => {
    const t = await setup()
    const payload = t.host.openCode()
    t.client.pair(1, { ...payload, addresses: [NOWHERE, STUDIO] }, 'MacBook Pro')
    // The owner sees this computer as the desktop app, under its own name and model.
    const confirm = await t.host.until(1, 'confirm')
    expect(confirm).toEqual({
      state: 'confirm',
      device: {
        name: 'Lin MacBook',
        model: 'MacBook Pro',
        kind: 'desktop',
        platform: 'macOS 26.1',
        known: false,
      },
    })
    expect(t.states(1)).toEqual(['connecting', 'confirm'])
    t.host.pairing.answer(1, { add: true, name: 'Desk' })

    const added = await t.pairingEnd(1)
    expect(added).toEqual({
      state: 'added',
      host: expect.objectContaining({
        id: t.hostId,
        name: 'Studio',
        platform: 'linux',
        version: '0.2.0',
        deviceName: 'Desk',
        // The answering address first, then the code's, as the host's welcome names none.
        addresses: [STUDIO, NOWHERE],
        removed: false,
        connection: { state: 'online', address: STUDIO },
      }),
    })
    // The host has this computer's own key, and this computer has the host's.
    const device = t.host.devices.withKey(t.deviceKey.publicKey)
    expect(device).toMatchObject({ name: 'Desk', kind: 'desktop', model: 'MacBook Pro' })
    await t.store.flush()
    const kept = (await HostStore.load(t.dir, quiet)).get(t.hostId)
    expect(kept).toMatchObject({
      publicKey: Buffer.from(t.hostKey.publicKey).toString('base64'),
      deviceName: 'Desk',
    })
    expect(t.host.server.online()).toEqual([device!.id])
  })

  it('says so when the owner does not add it', async () => {
    const t = await setup()
    t.client.pair(1, t.host.openCode(), 'MacBook Pro')
    await t.host.until(1, 'confirm')
    t.host.pairing.answer(1, { add: false, name: '' })
    expect(await t.pairingEnd(1)).toEqual({ state: 'failed', reason: 'rejected' })
    expect(t.client.list()).toEqual([])
  })

  it('says a code is no longer valid when the host ends the handshake', async () => {
    const t = await setup()
    const payload = t.host.openCode()
    // A code that was replaced: its secret no longer opens anything.
    t.host.openCode(2)
    t.client.pair(1, payload, 'MacBook Pro')
    expect(await t.pairingEnd(1)).toEqual({ state: 'failed', reason: 'void' })
  })

  it('takes a dropped handshake as the answer only once every address has failed', async () => {
    const t = await setup({ lateMs: 100 })
    const payload = t.host.openCode()
    t.client.pair(1, { ...payload, addresses: [PROXIED, STUDIO] }, 'MacBook Pro')
    await t.host.until(1, 'confirm')
    expect(t.states(1)).toEqual(['connecting', 'confirm'])
    t.host.pairing.answer(1, { add: true, name: 'Desk' })
    expect(await t.pairingEnd(1)).toMatchObject({
      state: 'added',
      host: { connection: { state: 'online', address: STUDIO } },
    })
  })

  it('says a host is unreachable when one address drops and another never answers', async () => {
    const t = await setup({ timeoutMs: 200 })
    t.client.pair(1, { ...t.host.openCode(), addresses: [PROXIED, NOWHERE] }, 'MacBook Pro')
    expect(await t.pairingEnd(1)).toEqual({ state: 'failed', reason: 'unreachable' })
  })

  it('gives up on a host nothing answers for within the timeout', async () => {
    expect(PAIR_HOST_TIMEOUT_MS).toBe(15_000)
    const t = await setup({ timeoutMs: 200 })
    t.setReachable(false)
    const started = Date.now()
    t.client.pair(1, t.host.openCode(), 'MacBook Pro')
    expect(await t.pairingEnd(1)).toEqual({ state: 'failed', reason: 'unreachable' })
    expect(Date.now() - started).toBeGreaterThanOrEqual(190)
  })

  it('ends when Add host closes, and the host takes devices with the code again', async () => {
    const t = await setup()
    t.client.pair(1, t.host.openCode(), 'MacBook Pro')
    await t.host.until(1, 'confirm')
    t.client.closePairing(1)
    await t.host.until(1, 'waiting')
    expect(t.states(1)).toEqual(['connecting', 'confirm'])
  })
})

describe('a known host', () => {
  it('carries the host protocol to main once welcomed', async () => {
    const t = await setup()
    await t.paired()
    await expect.poll(() => t.mainPorts.length).toBe(1)
    const port = t.mainPorts[0]!
    const answers: unknown[] = []
    port.onMessage((data) => answers.push(data))
    port.send({ type: 'request', id: 1, method: 'ping' })
    await expect.poll(() => answers).toEqual([{ type: 'response', id: 1, result: 'pong' }])
  })

  it("carries a request's bytes up as an upload and an answer's bytes back", async () => {
    const t = await setup()
    await t.paired()
    await expect.poll(() => t.mainPorts.length).toBe(1)
    const port = t.mainPorts[0]!
    const answers: { id: number; result: { got: number; bytes: ArrayBuffer } }[] = []
    port.onMessage((data) => answers.push(data as (typeof answers)[number]))
    const bytes = new Uint8Array(200_000).map((_, i) => i % 251)
    port.send({ type: 'request', id: 1, method: 'ping' })
    port.send({ type: 'request', id: 2, method: 'echo', params: { bytes: bytes.buffer } })
    await expect.poll(() => answers.length).toBe(2)
    const echo = answers.find((answer) => answer.id === 2)!
    expect(echo.result.got).toBe(bytes.length)
    expect(new Uint8Array(echo.result.bytes)).toEqual(bytes)
  })

  it("keeps main's port through a drop the host keeps the session through", async () => {
    const t = await setup({ timeoutMs: 100 })
    await t.paired()
    await expect.poll(() => t.mainPorts.length).toBe(1)
    const port = t.mainPorts[0]!
    const answers: unknown[] = []
    port.onMessage((data) => answers.push(data))
    port.send({ type: 'request', id: 1, method: 'ping' })
    await expect.poll(() => answers).toHaveLength(1)

    t.setReachable(false)
    t.hostEnds.at(-1)!.close()
    await expect.poll(() => t.connection()).toEqual({ state: 'offline' })
    // Asked while the host is out of reach: it goes once the session is resumed.
    port.send({ type: 'request', id: 2, method: 'ping' })
    t.setReachable(true)
    await expect
      .poll(() => answers)
      .toEqual([
        { type: 'response', id: 1, result: 'pong' },
        { type: 'response', id: 2, result: 'pong' },
      ])
    expect(t.connection()).toEqual({ state: 'online', address: STUDIO })
    expect(t.mainPorts).toHaveLength(1)
    expect(t.closedPorts.has(port)).toBe(false)
  })

  it('notices a host that stops answering, and resumes the session once it answers', async () => {
    const t = await setup({ timeoutMs: 100, keepalive: { quietMs: 50, answerMs: 50 } })
    await t.paired()
    await expect.poll(() => t.mainPorts.length).toBe(1)
    const port = t.mainPorts[0]!
    const answers: unknown[] = []
    port.onMessage((data) => answers.push(data))
    // Pings and their answers keep a quiet connection up.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(t.hostEnds).toHaveLength(1)

    // The host's process is stopped: its connection stays open, and neither it nor a new one
    // answers, nor ever closes.
    t.setReachable(false)
    t.wires[0]!.hang()
    await expect.poll(() => t.connection()).toEqual({ state: 'offline' })
    port.send({ type: 'request', id: 1, method: 'ping' })

    t.wires[0]!.wake()
    t.setReachable(true)
    await expect.poll(() => answers).toEqual([{ type: 'response', id: 1, result: 'pong' }])
    expect(t.connection()).toEqual({ state: 'online', address: STUDIO })
    expect(t.mainPorts).toHaveLength(1)
    expect(t.closedPorts.has(port)).toBe(false)
  })

  it('opens a new port for main once the host no longer keeps the session', async () => {
    const t = await setup({ timeoutMs: 100, resumeMs: 30 })
    await t.paired()
    await expect.poll(() => t.mainPorts.length).toBe(1)
    t.setReachable(false)
    t.hostEnds.at(-1)!.close()
    await expect.poll(() => t.connection()).toEqual({ state: 'offline' })
    await new Promise((resolve) => setTimeout(resolve, 60))
    t.setReachable(true)
    await expect.poll(() => t.mainPorts.length).toBe(2)
    expect(t.closedPorts.has(t.mainPorts[0]!)).toBe(true)
  })

  it('connects again with IK when the app starts again', async () => {
    const t = await setup()
    await t.paired()
    await t.client.stop()
    const again = t.makeClient(await HostStore.load(t.dir, quiet))
    again.start()
    expect(again.list()[0]!.connection).toEqual({ state: 'connecting' })
    await expect
      .poll(() => again.list()[0]!.connection)
      .toEqual({ state: 'online', address: STUDIO })
    // No code was open: the handshake was IK with the key the host knows.
    expect(t.host.server.online()).toHaveLength(1)
  })

  it('stops for good when the host removes it', async () => {
    const t = await setup({ timeoutMs: 100 })
    await t.paired()
    for (const id of t.host.server.online()) await t.host.server.removeDevice(id)
    await expect.poll(() => t.connection()?.state).toBe('stopped')
    // Removed is for good, so this host is tried no more.
    const dialed = t.dialed.length
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(t.dialed).toHaveLength(dialed)
    expect(t.connection()).toEqual({ state: 'stopped', reason: 'removed' })
    expect(t.store.get(t.hostId)!.removed).toBe(true)
  })

  it('reconnects with backoff: offline once a try fails, then online again', async () => {
    const t = await setup({ timeoutMs: 100 })
    await t.paired()
    const before = t.store.get(t.hostId)!.lastOnlineAt!
    t.setReachable(false)
    // Kettu on the host restarts: devices hear `stopping`.
    await t.host.server.stop('stopping')
    await expect.poll(() => t.connection()).toEqual({ state: 'offline' })
    expect(t.store.get(t.hostId)!.lastOnlineAt).toBeGreaterThanOrEqual(before)

    const restarted = await startHost(await tempFolder('kettu-client-'), t.hostKey)
    // The same identity and the same paired device on the host that came back.
    await restarted.devices.add({
      publicKey: Buffer.from(t.deviceKey.publicKey).toString('base64'),
      name: 'Desk',
      kind: 'desktop',
      platform: 'macOS 26.1',
      model: 'MacBook Pro',
    })
    t.host.server = restarted.server
    t.setReachable(true)
    await expect.poll(() => t.connection()).toEqual({ state: 'online', address: STUDIO })
  })

  it('keeps the addresses the host tells it, the answering one first', async () => {
    const t = await setup()
    await t.paired()
    const vpn = { host: '100.88.12.7', port: 47821 }
    t.host.server.setAddresses([vpn, STUDIO])
    await expect.poll(() => t.store.get(t.hostId)!.addresses).toEqual([STUDIO, vpn])
  })

  it('tries the addresses the owner gives it at once', async () => {
    // A try after a failure waits longer than the test does.
    const t = await setup({ retryMs: 60_000 })
    await t.paired()
    t.client.setAddresses(t.hostId, [NOWHERE])
    // Kettu on the host restarts, as when it changed its port.
    await t.host.server.stop('stopping')
    await expect.poll(() => t.connection()).toEqual({ state: 'connecting' })
    const restarted = await startHost(await tempFolder('kettu-client-'), t.hostKey)
    await restarted.devices.add({
      publicKey: Buffer.from(t.deviceKey.publicKey).toString('base64'),
      name: 'Desk',
      kind: 'desktop',
      platform: 'macOS 26.1',
      model: 'MacBook Pro',
    })
    t.host.server = restarted.server
    expect(t.client.setAddresses(t.hostId, [STUDIO])).toBe(true)
    await expect.poll(() => t.connection()).toEqual({ state: 'online', address: STUDIO })
  })

  it('says whether the host allows the terminal, from its welcome and as the owner changes it', async () => {
    const t = await setup()
    t.host.server.setTerminal(true)
    await t.paired()
    await expect
      .poll(() => t.connection())
      .toEqual({ state: 'online', address: STUDIO, terminal: true })
    await expect.poll(() => t.mainPorts.length).toBe(1)
    const heard: unknown[] = []
    t.mainPorts[0]!.onMessage((data) => heard.push(data))
    t.host.server.setTerminal(false)
    await expect.poll(() => t.connection()).toEqual({ state: 'online', address: STUDIO })
    t.host.server.setTerminal(true)
    await expect
      .poll(() => t.connection())
      .toEqual({ state: 'online', address: STUDIO, terminal: true })
    // The host's word is the link's own; main hears of it through the status.
    expect(heard).toEqual([])
  })

  it('renames this computer on the host, and hears the owner rename it', async () => {
    const t = await setup()
    await t.paired()
    const device = t.host.devices.withKey(t.deviceKey.publicKey)!
    expect(t.client.rename(t.hostId, 'Lin at home')).toBe(true)
    await expect.poll(() => t.host.devices.get(device.id)?.name).toBe('Lin at home')
    await expect.poll(() => t.store.get(t.hostId)!.deviceName).toBe('Lin at home')
    await t.host.server.renameDevice(device.id, 'Desk', 'owner')
    await expect.poll(() => t.store.get(t.hostId)!.deviceName).toBe('Desk')
  })

  it('forgets a host here only', async () => {
    const t = await setup()
    await t.paired()
    expect(await t.client.remove(t.hostId)).toBe(true)
    expect(t.client.list()).toEqual([])
    await expect.poll(() => t.host.server.online()).toEqual([])
    expect(t.host.devices.withKey(t.deviceKey.publicKey)).not.toBeNull()
    expect(t.client.rename(t.hostId, 'x')).toBe(false)
  })
})

describe('direct connections', () => {
  it('tries every address at once, and the first finished handshake wins', async () => {
    const dir = await tempFolder('kettu-client-')
    const hostKey = await generateKeyPair()
    const host = await startHost(dir, hostKey)
    const direct = new DirectListener({
      server: host.server,
      changed: quiet,
      log: quiet,
      host: '127.0.0.1',
    })
    await direct.apply({ enabled: true, port: 0, addresses: [] })
    cleanups.push(() => direct.stop())
    const status = direct.status
    if (status.state !== 'listening') throw new Error('Not listening')
    // A port nothing listens on, beside the host's.
    const closed = await new Promise<number>((resolve) => {
      const probe = createServer()
      probe.listen(0, '127.0.0.1', () => {
        const { port } = probe.address() as { port: number }
        probe.close(() => resolve(port))
      })
    })
    const payload = host.openCode()
    const live = { host: '127.0.0.1', port: status.port }
    const pairings: HostPairingState[] = []
    const client = new HostClient({
      key: await generateKeyPair(),
      hosts: await HostStore.load(dir, quiet),
      client: { kind: 'desktop', version: '0.3.0', platform: 'macOS 26.1' },
      name: () => 'Lin MacBook',
      changed: quiet,
      pairing: (_, state) => pairings.push(state),
      log: quiet,
      connect: connectTransport,
    })
    cleanups.push(() => client.stop())
    client.pair(1, { ...payload, addresses: [{ host: '127.0.0.1', port: closed }, live] }, '')
    await host.until(1, 'confirm')
    host.pairing.answer(1, { add: true, name: 'Lin MacBook' })
    await expect.poll(() => pairings.at(-1)?.state).toBe('added')
    expect(client.list()[0]!.connection).toEqual({ state: 'online', address: live })
  })
})

describe('forwards for the browser', () => {
  it('says hello as a desktop app that runs browser calls', async () => {
    const t = await setup()
    await t.paired()
    await expect.poll(() => t.host.agentEnds.length).toBe(1)
    expect(t.host.agentEnds[0]!.device).toMatchObject({ browser: true })
  })

  it('reach a dev server on the host once its agent host granted the port', async () => {
    const devServer = http.createServer((req, res) => res.end(`from the host: ${req.url}`))
    await new Promise<void>((resolve) => devServer.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve) => devServer.close(() => resolve())))
    const devPort = (devServer.address() as AddressInfo).port
    const t = await setup()
    await t.paired()
    await expect.poll(() => t.host.agentEnds.length).toBe(1)
    const forward = { host: '127.0.0.1' as const, port: devPort }
    t.host.agentEnds[0]!.port.send({
      type: 'event',
      event: { type: 'browser.call', call: { sessionId: 's1', forward } },
    })
    await expect.poll(() => t.mainPorts.length).toBe(1)
    const local = await t.client.forward(t.hostId, 's1', forward)
    expect(local).toEqual(expect.any(Number))
    const body = await new Promise<string>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port: local!, path: '/app', agent: false }, (res) => {
          let text = ''
          res.on('data', (chunk) => (text += chunk))
          res.on('end', () => resolve(text))
        })
        .on('error', reject)
    })
    expect(body).toBe('from the host: /app')
    expect(await t.client.forward('c'.repeat(32), 's1', forward)).toBeNull()
  })
})
