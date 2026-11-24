// This computer as a device of a host on a relay its owner runs: it reaches the host there with no
// token whether or not it is signed in to a Kettu account, so the account's token never goes to
// that relay; and it follows the host when the host moves to another relay.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeRelays } from '@shared/remote/fake-relay'
import { generateKeyPair } from '@shared/remote/noise'
import type { HostRelay } from '@shared/remote/relay'
import { importRelayKey, newRelaySeed, relayHostId } from '@shared/remote/relay'
import { RelayHost } from '@shared/remote/relay-host'
import { webSocketTransport } from '@shared/remote/websocket-transport'
import { ActivityLog } from './activity'
import { HostClient } from './client'
import { DeviceStore } from './devices'
import { DiscoveryRequests } from './discovery'
import { HostStore } from './hosts'
import { PairingCodes } from './pairing'
import { RemoteServer } from './server'
import { memoryPorts } from './testing/memory'

const MAIN = 'https://relay.test'
const OWN = 'https://relay.example.com'
const ACCESS_KEY = 'krk_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'
const log = (): void => {}
const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kettu-own-relay-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A host signed in to its owner's relay at OWN, and a device that knows it there. */
async function setup(deviceToken: string | null) {
  const relays = new FakeRelays()
  relays.accounts.set('laptop-token', 'account')
  relays.relay(OWN).useAccessKey(ACCESS_KEY)

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
  let relay: HostRelay = { id: relayId, urls: [OWN] }
  const server: RemoteServer = new RemoteServer({
    staticKey: hostKey,
    devices,
    activity: await ActivityLog.load(hostDir, log),
    pairing: new PairingCodes({ hostKey: hostKey.publicKey, addresses: () => [], send: () => {} }),
    discovery: new DiscoveryRequests({ send: () => {} }),
    host: { name: 'Studio', platform: 'darwin', version: '0.0.0-test' },
    uploads: path.join(hostDir, 'uploads'),
    openAgentPort: async () => memoryPorts()[0],
    relay: () => relay,
    changed: () => {},
    log,
  })
  const relayHost = new RelayHost({
    main: OWN,
    id: relayId,
    key: relayKey,
    own: { id: 'own', url: OWN },
    openSocket: relays.openSocket,
    fetchInfo: relays.fetchInfo,
    accepted: (socket) =>
      void webSocketTransport(socket, true).then((transport) => server.accept(transport, 'relay')),
    changed: () => {},
    log,
  })
  relayHost.start()
  relayHost.setToken(ACCESS_KEY)
  cleanups.push(async () => {
    relayHost.stop()
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
    relay,
  }))!
  const client: HostClient = new HostClient({
    key: laptopKey,
    hosts,
    client: { kind: 'desktop', version: '1.0.0', platform: 'macOS 26.1' },
    name: () => 'Laptop',
    openMainPort: async () => memoryPorts()[0],
    changed: () => {},
    pairing: () => {},
    log,
    connect: async () => {
      throw new Error('No route to the host')
    },
    relay: {
      main: MAIN,
      token: () => deviceToken,
      openSocket: relays.openSocket,
      fetchJson: relays.fetchJson,
    },
    timeoutMs: 5000,
    networkCheckMs: null,
  })
  cleanups.push(() => client.stop())
  await expect.poll(() => relays.relay(OWN).hosts.has(relayId), { timeout: 15_000 }).toBe(true)
  const connection = () => client.list().find((known) => known.id === host.id)!.connection
  return {
    relays,
    server,
    relayHost,
    client,
    hosts,
    host,
    connection,
    moveTo: (next: HostRelay) => {
      relay = next
      return server.relayMoved(next)
    },
  }
}

describe('a device of a host on its owner’s relay', () => {
  for (const [signed, token] of [
    ['signed in', 'laptop-token'],
    ['signed out', null],
  ] as const) {
    it(`reaches it with no token, ${signed}`, { timeout: 30_000 }, async () => {
      const t = await setup(token)
      t.client.start()
      await expect.poll(() => t.connection().state, { timeout: 15_000 }).toBe('online')
      expect(t.connection()).toMatchObject({ relay: OWN, own: true })
      expect(t.relays.relay(OWN).deviceTokens.length).toBeGreaterThan(0)
      expect(t.relays.relay(OWN).deviceTokens.every((sent) => sent === null)).toBe(true)
      // Nothing of the device went to the Kettu relay either.
      expect(t.relays.relay(MAIN).sockets).toHaveLength(0)
    })
  }

  it('keeps the relay the host moves to', { timeout: 30_000 }, async () => {
    const t = await setup(null)
    t.client.start()
    await expect.poll(() => t.connection().state, { timeout: 15_000 }).toBe('online')
    const next = { id: t.host.relay!.id, urls: ['https://other.example.com'] }
    t.moveTo(next)
    await expect.poll(() => t.hosts.list()[0]?.relay).toEqual(next)
  })

  it('hears the move before the host leaves the relay', { timeout: 30_000 }, async () => {
    const t = await setup(null)
    t.client.start()
    await expect.poll(() => t.connection().state, { timeout: 15_000 }).toBe('online')
    const next = { id: t.host.relay!.id, urls: ['https://other.example.com'] }
    await t.moveTo(next)
    // The host leaves the old relay as soon as the move has gone out.
    t.relayHost.stop()
    await expect.poll(() => t.hosts.list()[0]?.relay).toEqual(next)
  })
})
