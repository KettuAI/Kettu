// Updating an already-paired host's relay and direct addresses via a new pairing link: the device
// verifies the real host over a known-device Noise IK handshake first (requiring no owner
// re-approval while the host still knows it), falls back to the pairing PSK handshake if the host
// no longer knows it, rejects mismatched host keys, and never overwrites stored relay/addresses
// before a verified welcome.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeRelays } from '@shared/remote/fake-relay'
import type { HostPairingState } from '@shared/remote/hosts'
import { generateKeyPair } from '@shared/remote/noise'
import { parsePairingLink, type PairingState } from '@shared/remote/pairing'
import type { DirectAddress } from '@shared/remote/protocol'
import { importRelayKey, newRelaySeed, relayHostId, type HostRelay } from '@shared/remote/relay'
import { RelayHost } from '@shared/remote/relay-host'
import { webSocketTransport } from '@shared/remote/websocket-transport'
import { ActivityLog } from './activity'
import { HostClient } from './client'
import { DeviceStore } from './devices'
import { DiscoveryRequests } from './discovery'
import { HostStore } from './hosts'
import { PairingCodes } from './pairing'
import { RemoteServer } from './server'
import { memoryPorts, memoryTransports } from './testing/memory'

const MAIN = 'https://relay.test'
const OWN_A = 'https://relay-a.example.com'
const OWN_B = 'https://relay-b.example.com'
const BOGUS = 'https://bogus.example.com'
const ACCESS_KEY = 'krk_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'
const log = (): void => {}
const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kettu-relay-recovery-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

async function setup(options?: { directAddr?: DirectAddress }) {
  const relays = new FakeRelays()
  relays.relay(OWN_A).useAccessKey(ACCESS_KEY)
  relays.relay(OWN_B).useAccessKey(ACCESS_KEY)
  relays.relay(BOGUS).useAccessKey(ACCESS_KEY)

  const hostDir = tempDir()
  const hostKey = await generateKeyPair()
  const laptopKey = await generateKeyPair()
  const relayKey = await importRelayKey(await newRelaySeed())
  const relayId = await relayHostId(relayKey.publicKey)
  const devices = await DeviceStore.load(hostDir, log)
  const laptopPub = Buffer.from(laptopKey.publicKey).toString('base64')
  const device = (await devices.add({
    publicKey: laptopPub,
    name: 'Laptop',
    kind: 'desktop',
    platform: 'darwin',
    model: '',
  }))!

  let currentRelay: HostRelay | null = { id: relayId, urls: [OWN_A] }
  let currentDirect: DirectAddress[] = []
  const hostPairingEvents: PairingState[] = []
  const pairing = new PairingCodes({
    hostKey: hostKey.publicKey,
    addresses: () => currentDirect,
    relay: () => currentRelay,
    send: (_codeId, state) => hostPairingEvents.push(state),
  })
  const server: RemoteServer = new RemoteServer({
    staticKey: hostKey,
    devices,
    activity: await ActivityLog.load(hostDir, log),
    pairing,
    discovery: new DiscoveryRequests({ send: () => {} }),
    host: { name: 'Studio', platform: 'darwin', version: '0.1.25' },
    uploads: path.join(hostDir, 'uploads'),
    openAgentPort: async () => memoryPorts()[0],
    relay: () => currentRelay,
    changed: () => {},
    log,
  })

  let relayHost: RelayHost | null = null
  const connectRelay = async (url: string | null): Promise<void> => {
    relayHost?.stop()
    relayHost = null
    currentRelay = url ? { id: relayId, urls: [url] } : null
    if (!url) return
    relayHost = new RelayHost({
      main: url,
      id: relayId,
      key: relayKey,
      own: { id: 'own', url },
      openSocket: relays.openSocket,
      fetchInfo: relays.fetchInfo,
      accepted: (socket) =>
        void webSocketTransport(socket, true).then((transport) =>
          server.accept(transport, 'relay'),
        ),
      changed: () => {},
      log,
    })
    relayHost.start()
    relayHost.setToken(ACCESS_KEY)
    await expect.poll(() => relays.relay(url).hosts.has(relayId), { timeout: 15_000 }).toBe(true)
  }

  await connectRelay(OWN_A)
  cleanups.push(async () => {
    relayHost?.stop()
    await server.stop('stopping')
  })

  let clock = 1_700_000_000_000
  const hosts = await HostStore.load(tempDir(), log, () => clock)
  const host = (await hosts.add({
    publicKey: Buffer.from(hostKey.publicKey).toString('base64'),
    name: 'Studio',
    platform: 'darwin',
    version: '0.1.25',
    addresses: [],
    deviceName: 'Laptop',
    relay: { id: relayId, urls: [OWN_A] },
  }))!
  const originalAddedAt = host.addedAt
  clock += 60_000

  const clientPairingEvents = new Map<number, HostPairingState[]>()
  const client: HostClient = new HostClient({
    key: laptopKey,
    hosts,
    client: { kind: 'desktop', version: '0.1.25', platform: 'macOS 26.1' },
    name: () => 'Laptop',
    openMainPort: async () => memoryPorts()[0],
    changed: () => {},
    pairing: (pairId, state) => {
      const list = clientPairingEvents.get(pairId) ?? []
      list.push(state)
      clientPairingEvents.set(pairId, list)
    },
    log,
    connect: async (address) => {
      if (
        options?.directAddr &&
        address.host === options.directAddr.host &&
        address.port === options.directAddr.port
      ) {
        const [a, b] = memoryTransports()
        server.accept(b, 'direct')
        return a
      }
      throw new Error('No direct route')
    },
    relay: {
      main: MAIN,
      token: () => null,
      openSocket: relays.openSocket,
      fetchJson: relays.fetchJson,
    },
    timeoutMs: 1500,
    now: () => clock,
    networkCheckMs: null,
  })
  cleanups.push(() => client.stop())

  const openCode = (codeId = 1): string => {
    hostPairingEvents.length = 0
    pairing.open(codeId)
    const waiting = hostPairingEvents.find(
      (event): event is Extract<PairingState, { state: 'waiting' }> => event.state === 'waiting',
    )
    if (!waiting) throw new Error('Pairing code did not open')
    return waiting.link
  }

  return {
    relays,
    server,
    devices,
    device,
    pairing,
    hostPairingEvents,
    client,
    hosts,
    host,
    originalAddedAt,
    relayId,
    clientPairingEvents,
    connectRelay,
    setDirect: (addresses: DirectAddress[]) => {
      currentDirect = addresses
      server.setAddresses(addresses)
    },
    openCode,
  }
}

describe('recovering an already-paired host via a new pairing link', () => {
  it(
    'updates the host relay over a known-device IK handshake without owner re-approval or resetting addedAt',
    { timeout: 30_000 },
    async () => {
      const t = await setup()
      t.client.start()
      await expect
        .poll(() => t.client.statusOf(t.host.id)?.connection.state, { timeout: 15_000 })
        .toBe('online')

      // Simulate the host turning off its relay (clearing device relay) and later moving to OWN_B
      // while the device is offline.
      await t.server.relayMoved(null)
      await expect.poll(() => t.hosts.get(t.host.id)?.relay).toBeUndefined()
      await t.connectRelay(OWN_B)
      await expect
        .poll(() => t.client.statusOf(t.host.id)?.connection.state, { timeout: 15_000 })
        .toBe('offline')

      const link = t.openCode(10)
      const payload = parsePairingLink(link)!
      t.client.pair(1, payload, 'MacBookPro')

      await expect
        .poll(() => t.clientPairingEvents.get(1)?.at(-1)?.state, { timeout: 15_000 })
        .toBe('added')

      const finalEvent = t.clientPairingEvents.get(1)!.at(-1)!
      expect(finalEvent).toMatchObject({ state: 'added', updated: true })
      // The host never asked for owner re-approval because the known-device IK handshake succeeded.
      expect(t.hostPairingEvents.some((event) => event.state === 'confirm')).toBe(false)
      expect(t.hosts.list()).toHaveLength(1)
      expect(t.hosts.get(t.host.id)?.addedAt).toBe(t.originalAddedAt)
      expect(t.hosts.get(t.host.id)?.relay).toEqual({ id: t.relayId, urls: [OWN_B] })
      expect(t.client.statusOf(t.host.id)?.connection).toMatchObject({
        state: 'online',
        relay: OWN_B,
        own: true,
      })
    },
  )

  it(
    'clears the old relay and adopts direct addresses when the host switched to no relay',
    { timeout: 30_000 },
    async () => {
      const directAddr: DirectAddress = { host: '192.168.1.42', port: 4567 }
      const t = await setup({ directAddr })
      // Host switches to no relay and listens directly while the device never started on OWN_A.
      await t.connectRelay(null)
      t.setDirect([directAddr])
      t.client.start()
      await expect
        .poll(() => t.client.statusOf(t.host.id)?.connection.state, { timeout: 15_000 })
        .toBe('offline')

      const link = t.openCode(11)
      const payload = parsePairingLink(link)!
      expect(payload.relay).toBeUndefined()
      t.client.pair(2, payload, 'MacBookPro')

      await expect
        .poll(() => t.clientPairingEvents.get(2)?.at(-1)?.state, { timeout: 15_000 })
        .toBe('added')

      expect(t.clientPairingEvents.get(2)!.at(-1)).toMatchObject({ state: 'added', updated: true })
      expect(t.hostPairingEvents.some((event) => event.state === 'confirm')).toBe(false)
      expect(t.hosts.get(t.host.id)?.addedAt).toBe(t.originalAddedAt)
      expect(t.hosts.get(t.host.id)?.relay).toBeUndefined()
      expect(t.hosts.get(t.host.id)?.addresses).toEqual([directAddr])
      expect(t.client.statusOf(t.host.id)?.connection).toMatchObject({
        state: 'online',
        address: directAddr,
      })
    },
  )

  it(
    'falls back to the pairing PSK handshake when the host no longer knows this device',
    { timeout: 30_000 },
    async () => {
      const t = await setup()
      // Host removes the device and moves to OWN_B while the device is offline.
      await t.server.removeDevice(t.device.id)
      await t.connectRelay(OWN_B)
      t.client.start()
      await expect
        .poll(() => t.client.statusOf(t.host.id)?.connection.state, { timeout: 15_000 })
        .toBe('offline')

      const link = t.openCode(12)
      const payload = parsePairingLink(link)!
      t.client.pair(3, payload, 'MacBookPro')

      await expect
        .poll(() => t.hostPairingEvents.some((event) => event.state === 'confirm'), {
          timeout: 15_000,
        })
        .toBe(true)
      t.pairing.answer(12, { add: true, name: 'Laptop' })

      await expect
        .poll(() => t.clientPairingEvents.get(3)?.at(-1)?.state, { timeout: 15_000 })
        .toBe('added')

      expect(t.hosts.list()).toHaveLength(1)
      expect(t.hosts.get(t.host.id)?.addedAt).toBe(t.originalAddedAt)
      expect(t.hosts.get(t.host.id)?.relay).toEqual({ id: t.relayId, urls: [OWN_B] })
      expect(t.client.statusOf(t.host.id)?.connection).toMatchObject({
        state: 'online',
        relay: OWN_B,
        own: true,
      })
    },
  )

  it(
    'rejects a pairing link for a different host when an expected host id is given',
    { timeout: 30_000 },
    async () => {
      const t = await setup()
      const otherKey = await generateKeyPair()
      const otherPairing = new PairingCodes({
        hostKey: otherKey.publicKey,
        addresses: () => [],
        relay: () => ({ id: t.relayId, urls: [OWN_B] }),
        send: () => {},
      })
      let otherLink = ''
      const capture = new PairingCodes({
        hostKey: otherKey.publicKey,
        addresses: () => [],
        relay: () => ({ id: t.relayId, urls: [OWN_B] }),
        send: (_id, state) => {
          if (state.state === 'waiting') otherLink = state.link
        },
      })
      capture.open(1)
      otherPairing.close(1)
      const payload = parsePairingLink(otherLink)!

      t.client.pair(4, payload, 'MacBookPro', t.host.id)
      await expect
        .poll(() => t.clientPairingEvents.get(4)?.at(-1), { timeout: 5_000 })
        .toEqual({ state: 'failed', reason: 'other_host' })
      // Original host record stays untouched.
      expect(t.hosts.get(t.host.id)?.relay).toEqual({ id: t.relayId, urls: [OWN_A] })
      expect(t.hosts.get(t.host.id)?.addedAt).toBe(t.originalAddedAt)
    },
  )

  it(
    'keeps stored relay and addresses untouched if the new pairing link cannot verify with the real host',
    { timeout: 30_000 },
    async () => {
      const t = await setup()
      const link = t.openCode(13)
      const payload = parsePairingLink(link)!
      // Point the link at a relay where the real host is not signed in.
      const unverified = {
        ...payload,
        relay: { id: t.relayId, urls: [BOGUS] },
        addresses: [{ host: '10.255.255.1', port: 4567 }],
      }

      t.client.pair(5, unverified, 'MacBookPro', t.host.id)
      await expect
        .poll(() => t.clientPairingEvents.get(5)?.at(-1), { timeout: 15_000 })
        .toEqual({ state: 'failed', reason: 'unreachable' })

      expect(t.hosts.get(t.host.id)?.relay).toEqual({ id: t.relayId, urls: [OWN_A] })
      expect(t.hosts.get(t.host.id)?.addresses).toEqual([])
      expect(t.hosts.get(t.host.id)?.addedAt).toBe(t.originalAddedAt)
    },
  )

  it(
    'falls back to PSK pairing when the host drops an unknown IK handshake completely',
    { timeout: 30_000 },
    async () => {
      const t = await setup()
      // Replace the host's device store with a fresh empty store while keeping the same host key,
      // so the host drops the IK handshake rather than sending closing: 'removed'.
      const freshDir = tempDir()
      const emptyDevices = await DeviceStore.load(freshDir, log)
      const hostPairingEvents: PairingState[] = []
      const freshPairing = new PairingCodes({
        hostKey: t.server.options.staticKey.publicKey,
        addresses: () => [],
        relay: () => ({ id: t.relayId, urls: [OWN_B] }),
        send: (_codeId, state) => hostPairingEvents.push(state),
      })
      const freshServer = new RemoteServer({
        staticKey: t.server.options.staticKey,
        devices: emptyDevices,
        activity: await ActivityLog.load(freshDir, log),
        pairing: freshPairing,
        discovery: new DiscoveryRequests({ send: () => {} }),
        host: { name: 'Studio', platform: 'darwin', version: '0.1.25' },
        uploads: path.join(freshDir, 'uploads'),
        openAgentPort: async () => memoryPorts()[0],
        relay: () => ({ id: t.relayId, urls: [OWN_B] }),
        changed: () => {},
        log,
      })
      const relayKey = await importRelayKey(await newRelaySeed())
      const relayId = await relayHostId(relayKey.publicKey)
      const freshRelayHost = new RelayHost({
        main: OWN_B,
        id: relayId,
        key: relayKey,
        own: { id: 'own', url: OWN_B },
        openSocket: t.relays.openSocket,
        fetchInfo: t.relays.fetchInfo,
        accepted: (socket) =>
          void webSocketTransport(socket, true).then((transport) =>
            freshServer.accept(transport, 'relay'),
          ),
        changed: () => {},
        log,
      })
      freshRelayHost.start()
      freshRelayHost.setToken(ACCESS_KEY)
      cleanups.push(async () => {
        freshRelayHost.stop()
        await freshServer.stop('stopping')
      })
      await expect
        .poll(() => t.relays.relay(OWN_B).hosts.has(relayId), { timeout: 15_000 })
        .toBe(true)

      freshPairing.open(20)
      const waiting = hostPairingEvents.find(
        (event): event is Extract<PairingState, { state: 'waiting' }> => event.state === 'waiting',
      )!
      const payload = {
        ...parsePairingLink(waiting.link)!,
        relay: { id: relayId, urls: [OWN_B] },
      }
      t.client.pair(6, payload, 'MacBookPro', t.host.id)

      await expect
        .poll(() => hostPairingEvents.some((event) => event.state === 'confirm'), {
          timeout: 15_000,
        })
        .toBe(true)
      freshPairing.answer(20, { add: true, name: 'Laptop' })

      await expect
        .poll(() => t.clientPairingEvents.get(6)?.at(-1)?.state, { timeout: 15_000 })
        .toBe('added')
      expect(t.hosts.get(t.host.id)?.addedAt).toBe(t.originalAddedAt)
      expect(t.client.statusOf(t.host.id)?.connection).toMatchObject({
        state: 'online',
        relay: OWN_B,
        own: true,
      })
    },
  )
})
