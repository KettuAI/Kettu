// Peer-to-peer paths over node-datachannel's real WebRTC on this computer: the DataChannel as a
// transport, an offer and its answer opening one, and a desktop device moving its session from
// the relay onto it and back to the relay standby once it closes, losing and repeating nothing.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeRelays } from '@shared/remote/fake-relay'
import type { HostAdminEvent } from '@shared/remote/host-admin'
import type { HostConnection } from '@shared/remote/hosts'
import { generateKeyPair, MAX_NOISE_MESSAGE } from '@shared/remote/noise'
import {
  PeerAnswers,
  PeerOffer,
  type P2pMessage,
  type PeerSystem,
  type RtcPeerConnection,
} from '@shared/remote/p2p'
import { importRelayKey, newRelaySeed, relayHostId } from '@shared/remote/relay'
import { RelayHost } from '@shared/remote/relay-host'
import type { Transport } from '@shared/remote/transport'
import { webSocketTransport } from '@shared/remote/websocket-transport'
import { ActivityLog } from './activity'
import { HostClient } from './client'
import { DeviceStore } from './devices'
import { DiscoveryRequests } from './discovery'
import { HostStore } from './hosts'
import { PairingCodes } from './pairing'
import { loadPeers } from './peers'
import { RemoteServer } from './server'
import { memoryPorts } from './testing/memory'

const MAIN = 'https://relay.test'
const log = (): void => {}
const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** This computer's WebRTC without STUN, its peer connections kept to close them as a path that goes. */
async function system(): Promise<PeerSystem & { peers: RtcPeerConnection[] }> {
  const create = await loadPeers(log)
  if (!create) throw new Error('node-datachannel did not load')
  const peers: RtcPeerConnection[] = []
  cleanups.push(() => {
    for (const peer of peers) peer.close()
  })
  return {
    peers,
    stun: () => [],
    create: (config) => {
      const peer = create(config)
      peers.push(peer)
      return peer
    },
  }
}

/** A device's offer and a host's answers wired to each other, as the session would carry them. */
async function opened(): Promise<{ device: Transport; host: Transport }> {
  const [deviceSide, hostSide] = await Promise.all([system(), system()])
  let offer: PeerOffer | null = null
  const accepted = new Promise<Transport>((resolve) => {
    const answers = new PeerAnswers({
      system: hostSide,
      send: (message) => queueMicrotask(() => offer?.signal(message)),
      accept: resolve,
    })
    cleanups.push(() => answers.close())
    offer = new PeerOffer({
      system: deviceSide,
      send: (message: P2pMessage) => queueMicrotask(() => answers.signal(message)),
    })
  })
  const [device, host] = await Promise.all([offer!.opened, accepted])
  cleanups.push(() => {
    device.close()
    host.close()
  })
  return { device, host }
}

function received(transport: Transport): Uint8Array[] {
  const messages: Uint8Array[] = []
  transport.onMessage((message) => messages.push(message))
  return messages
}

describe('a DataChannel as a transport', () => {
  it('carries whole Noise messages both ways, in order', { timeout: 20_000 }, async () => {
    const { device, host } = await opened()
    const atHost = received(host)
    const atDevice = received(device)
    const largest = new Uint8Array(MAX_NOISE_MESSAGE).fill(7)
    for (let i = 0; i < 50; i++) device.send(Uint8Array.of(i))
    device.send(largest)
    host.send(Uint8Array.of(1, 2, 3))
    await expect.poll(() => atHost.length, { timeout: 10_000 }).toBe(51)
    expect(atHost.slice(0, 50).map((message) => message[0])).toEqual([...Array(50).keys()])
    expect(atHost[50]).toEqual(largest)
    await expect.poll(() => atDevice.length).toBe(1)
    expect(atDevice[0]).toEqual(Uint8Array.of(1, 2, 3))
    expect(() => device.send(new Uint8Array(MAX_NOISE_MESSAGE + 1))).toThrow(RangeError)
  })

  it('holds what comes while paused, and drains', { timeout: 20_000 }, async () => {
    const { device, host } = await opened()
    host.pause()
    const atHost = received(host)
    for (let i = 0; i < 20; i++) device.send(new Uint8Array(MAX_NOISE_MESSAGE))
    await device.drained()
    expect(device.buffered()).toBe(0)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(atHost).toHaveLength(0)
    host.resume()
    await expect.poll(() => atHost.length, { timeout: 10_000 }).toBe(20)
  })

  it('ends on both sides when either closes it', { timeout: 20_000 }, async () => {
    const { device, host } = await opened()
    const ended = new Promise<void>((resolve) => host.onClose(resolve))
    device.close()
    await ended
    expect(host.buffered()).toBe(0)
    await expect(host.drained()).resolves.toBeUndefined()
  })
})

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kettu-p2p-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** The host hears what comes through the relay `ms` late, as a relay far away. */
function late(transport: Transport, ms: number): Transport {
  return {
    ...transport,
    onMessage: (listener) =>
      transport.onMessage((message) => void setTimeout(() => listener(message), ms)),
    onClose: (listener) => transport.onClose(() => void setTimeout(listener, ms)),
  }
}

async function setup() {
  const relays = new FakeRelays()
  relays.accounts.set('host-token', 'account')
  relays.accounts.set('laptop-token', 'account')
  const [hostPeers, laptopPeers] = await Promise.all([system(), system()])

  const hostDir = tempDir()
  const hostKey = await generateKeyPair()
  const laptopKey = await generateKeyPair()
  const relayKey = await importRelayKey(await newRelaySeed())
  const relayId = await relayHostId(relayKey.publicKey)
  const devices = await DeviceStore.load(hostDir, log)
  await devices.add({
    publicKey: Buffer.from(laptopKey.publicKey).toString('base64'),
    name: 'Laptop',
    kind: 'desktop',
    platform: 'darwin',
    model: '',
  })
  const server: RemoteServer = new RemoteServer({
    staticKey: hostKey,
    devices,
    activity: await ActivityLog.load(hostDir, log),
    pairing: new PairingCodes({ hostKey: hostKey.publicKey, addresses: () => [], send: () => {} }),
    discovery: new DiscoveryRequests({ send: () => {} }),
    host: { name: 'Studio', platform: 'darwin', version: '0.0.0-test' },
    uploads: path.join(hostDir, 'uploads'),
    openAgentPort: async () => memoryPorts()[0],
    relay: () => ({ id: relayId, urls: [MAIN] }),
    peers: () => hostPeers,
    changed: () => {},
    log,
  })
  const relay = new RelayHost({
    main: MAIN,
    id: relayId,
    key: relayKey,
    openSocket: relays.openSocket,
    fetchInfo: relays.fetchInfo,
    accepted: (socket) =>
      void webSocketTransport(socket, true).then((transport) =>
        server.accept(late(transport, 100), 'relay'),
      ),
    profile: () => null,
    changed: () => {},
    log,
  })
  relay.start()
  relay.setToken('host-token')
  cleanups.push(async () => {
    relay.stop()
    await server.stop('stopping')
  })

  const hosts = await HostStore.load(tempDir(), log)
  const host = (await hosts.add({
    publicKey: Buffer.from(hostKey.publicKey).toString('base64'),
    name: 'Studio',
    platform: 'darwin',
    version: '0.0.0-test',
    addresses: [],
    deviceName: 'Laptop',
    relay: { id: relayId, urls: [MAIN] },
  }))!
  const main: unknown[] = []
  const states: HostConnection['state'][] = []
  const punched: boolean[] = []
  const client: HostClient = new HostClient({
    key: laptopKey,
    hosts,
    client: { kind: 'desktop', version: '1.0.0', platform: 'macOS 26.1' },
    name: () => 'Laptop',
    openMainPort: async () => {
      const [ours, theirs] = memoryPorts()
      theirs.onMessage((message) => main.push(message))
      return ours
    },
    changed: () => {
      const state = client.list()[0]?.connection.state
      if (state && state !== states.at(-1)) states.push(state)
    },
    pairing: () => {},
    log,
    relay: {
      main: MAIN,
      token: () => 'laptop-token',
      openSocket: relays.openSocket,
      fetchJson: relays.fetchJson,
    },
    timeoutMs: 5000,
    networkCheckMs: null,
    peers: () => laptopPeers,
    punched: (opened) => punched.push(opened),
  })
  cleanups.push(() => client.stop())
  await expect.poll(() => relays.relay(MAIN).hosts.has(relayId)).toBe(true)

  const via = (): string => {
    const connection = client.list().find((known) => known.id === host.id)!.connection
    if (connection.state !== 'online') return connection.state
    return 'p2p' in connection ? 'p2p' : 'relay' in connection ? 'relay' : 'direct'
  }
  const events = (): number[] =>
    main
      .filter((message) => (message as { type?: unknown }).type === 'event')
      .map((message) => (message as { event: { n: number } }).event.n)
  return { server, client, via, events, states, punched, hostPeers }
}

describe('a desktop device on a peer-to-peer path', () => {
  it(
    'moves there from the relay and back to the relay standby, losing and repeating nothing',
    { timeout: 60_000 },
    async () => {
      const t = await setup()
      t.client.start()
      await expect.poll(t.via, { timeout: 15_000 }).toBe('relay')

      // The host keeps sending while the session moves under it.
      let sent = 0
      const sending = setInterval(() => {
        t.server.adminEvent({ type: 'test', n: ++sent } as unknown as HostAdminEvent, null)
      }, 3)
      cleanups.push(() => clearInterval(sending))

      // Welcomed on the relay, the device offers a path of its own and moves to it.
      await expect.poll(t.via, { timeout: 20_000 }).toBe('p2p')
      expect(t.punched).toEqual([true])
      const moved = sent
      await expect.poll(() => t.events().length, { timeout: 15_000 }).toBeGreaterThan(moved + 5)

      // The path goes: the relay standby takes the session over.
      for (const peer of t.hostPeers.peers) peer.close()
      await expect.poll(t.via, { timeout: 15_000 }).toBe('relay')
      const back = sent
      await expect.poll(() => t.events().length, { timeout: 15_000 }).toBeGreaterThan(back + 5)

      clearInterval(sending)
      const last = sent
      await expect.poll(() => t.events().at(-1), { timeout: 15_000 }).toBe(last)
      expect(t.events()).toEqual(Array.from({ length: last }, (_, i) => i + 1))
      // Online throughout: neither move showed a drop.
      expect(t.states).toEqual(['online'])
    },
  )
})
