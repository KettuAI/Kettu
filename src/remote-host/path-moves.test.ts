// This computer as a device moving its session between paths: from the relay to a direct address
// once the host is reachable there, keeping the relay on standby, and back to the standby once the
// direct path goes, with nothing the host sent lost or repeated and no drop shown meanwhile.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeRelays } from '@shared/remote/fake-relay'
import type { HostAdminEvent } from '@shared/remote/host-admin'
import type { HostConnection } from '@shared/remote/hosts'
import { generateKeyPair } from '@shared/remote/noise'
import type { DirectAddress } from '@shared/remote/protocol'
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
import { RemoteServer } from './server'
import { memoryPorts, memoryTransports } from './testing/memory'

const MAIN = 'https://relay.test'
const LAN: DirectAddress = { host: '192.168.1.8', port: 47821 }
const log = (): void => {}
const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kettu-path-moves-'))
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

  // The host's address on the network this computer may join, and its connections there.
  const lan = { up: false, ends: [] as Transport[] }
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
  // What reached main, and every connection state the host had.
  const main: unknown[] = []
  const states: HostConnection['state'][] = []
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
    connect: async (address) => {
      if (!lan.up || address.host !== LAN.host) throw new Error('No route to the host')
      const [deviceEnd, hostEnd] = memoryTransports()
      lan.ends.push(hostEnd)
      server.accept(hostEnd)
      return deviceEnd
    },
    relay: {
      main: MAIN,
      token: () => 'laptop-token',
      openSocket: relays.openSocket,
      fetchJson: relays.fetchJson,
    },
    timeoutMs: 5000,
    networkCheckMs: null,
  })
  cleanups.push(() => client.stop())
  await expect.poll(() => relays.relay(MAIN).hosts.has(relayId)).toBe(true)

  const via = (): string => {
    const connection = client.list().find((known) => known.id === host.id)!.connection
    if (connection.state !== 'online') return connection.state
    return 'relay' in connection ? 'relay' : 'direct'
  }
  const events = (): number[] =>
    main
      .filter((message) => (message as { type?: unknown }).type === 'event')
      .map((message) => (message as { event: { n: number } }).event.n)
  return { server, client, lan, via, events, states }
}

describe('a device moving its session between paths', () => {
  it(
    'moves to the direct path and back to the relay standby, losing and repeating nothing',
    {
      timeout: 60_000,
    },
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
      await expect.poll(() => t.events().length, { timeout: 15_000 }).toBeGreaterThan(5)

      // This computer joins the host's network.
      t.lan.up = true
      t.server.setAddresses([LAN])
      t.client.resume()
      await expect.poll(t.via, { timeout: 15_000 }).toBe('direct')
      const moved = sent
      await expect.poll(() => t.events().length, { timeout: 15_000 }).toBeGreaterThan(moved + 5)

      // It leaves it: the direct path goes, and the relay standby takes the session over.
      t.lan.up = false
      for (const end of t.lan.ends) end.close()
      await expect.poll(t.via, { timeout: 15_000 }).toBe('relay')
      const back = sent
      await expect.poll(() => t.events().length, { timeout: 15_000 }).toBeGreaterThan(back + 5)

      clearInterval(sending)
      const last = sent
      await expect.poll(() => t.events().at(-1), { timeout: 15_000 }).toBe(last)
      expect(t.events()).toEqual(Array.from({ length: last }, (_, i) => i + 1))
      // Online throughout: no move or promotion showed a drop.
      expect(t.states).toEqual(['online'])
    },
  )
})
