// Pairing with a host of the same Kettu account end to end: the host on the test relay with its
// profile, this computer's client listing it and pairing with it through the relay.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DiscoveryRequestEvent } from '@shared/remote/discovery'
import { FakeRelays } from '@shared/remote/fake-relay'
import type { HostPairingState } from '@shared/remote/hosts'
import { generateKeyPair } from '@shared/remote/noise'
import { hostProfile, importRelayKey, newRelaySeed, relayHostId } from '@shared/remote/relay'
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
const log = (): void => {}
const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kettu-account-pairing-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

async function setup(laptopToken = 'laptop-token') {
  const relays = new FakeRelays()
  relays.accounts.set('host-token', 'account')
  relays.accounts.set('laptop-token', 'account')
  relays.accounts.set('stranger-token', 'another account')

  const hostDir = tempDir()
  const hostKey = await generateKeyPair()
  const relayKey = await importRelayKey(await newRelaySeed())
  const relayId = await relayHostId(relayKey.publicKey)
  const events: DiscoveryRequestEvent[] = []
  const discovery = new DiscoveryRequests({ send: (event) => events.push(event) })
  const server: RemoteServer = new RemoteServer({
    staticKey: hostKey,
    devices: await DeviceStore.load(hostDir, log),
    activity: await ActivityLog.load(hostDir, log),
    pairing: new PairingCodes({ hostKey: hostKey.publicKey, addresses: () => [], send: () => {} }),
    discovery,
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
      void webSocketTransport(socket, true).then((transport) => server.accept(transport, 'relay')),
    profile: () => (discovery.on ? hostProfile(hostKey.publicKey, 'Studio', 'darwin') : null),
    changed: () => {},
    log,
  })
  relay.start()
  relay.setToken('host-token')
  discovery.setEnabled(true)
  relay.profileChanged()
  cleanups.push(async () => {
    relay.stop()
    await server.stop('stopping')
  })

  const states: HostPairingState[] = []
  const client = new HostClient({
    key: await generateKeyPair(),
    hosts: await HostStore.load(tempDir(), log),
    client: { kind: 'desktop', version: '1.0.0', platform: 'macOS 26.1' },
    name: () => 'Laptop',
    changed: () => {},
    pairing: (_, state) => states.push(state),
    log,
    relay: {
      main: MAIN,
      token: () => laptopToken,
      openSocket: relays.openSocket,
      fetchJson: relays.fetchJson,
    },
    timeoutMs: 5000,
  })
  cleanups.push(() => client.stop())
  await expect.poll(() => relays.relay(MAIN).hosts.get(relayId)?.profile).toBeTruthy()
  return { relays, relay, relayId, hostKey, server, discovery, events, client, states }
}

describe('pairing with a host of the account through the relay', () => {
  it('lists the host, shows the same code on both sides, and adds it once both say yes', async () => {
    const t = await setup()
    const publicKey = Buffer.from(t.hostKey.publicKey).toString('base64')
    expect(await t.client.discover(null)).toEqual({
      state: 'ok',
      hosts: [{ relayId: t.relayId, publicKey, name: 'Studio', platform: 'darwin' }],
    })
    // This computer's own host is not one to pair with.
    expect(await t.client.discover(publicKey)).toEqual({ state: 'ok', hosts: [] })

    t.client.pairDiscovered(1, t.relayId, null, 'MacBook Air')
    await expect.poll(() => t.states.at(-1)?.state).toBe('compare')
    await expect.poll(() => t.events.length).toBe(1)
    const asked = t.events[0]!.request
    const compared = t.states.at(-1)!
    if (asked.state !== 'confirm' || compared.state !== 'compare') throw new Error('Not asked')
    expect(compared).toEqual({ state: 'compare', code: asked.code, matched: false })
    expect(asked.device).toMatchObject({ name: 'Laptop', model: 'MacBook Air', kind: 'desktop' })

    t.client.matchPairing(1, true)
    expect(t.states.at(-1)).toEqual({ state: 'compare', code: asked.code, matched: true })
    t.discovery.answer(1, true, 'Laptop')
    await expect.poll(() => t.states.at(-1)?.state).toBe('added')
    const added = t.states.at(-1)!
    expect(added).toMatchObject({
      state: 'added',
      host: { publicKey, name: 'Studio', relay: { id: t.relayId, urls: [MAIN] } },
    })
    // Paired now, it is no longer listed.
    expect(await t.client.discover(null)).toEqual({ state: 'ok', hosts: [] })
  })

  it('ends when this computer says the codes differ, and the host hears it', async () => {
    const t = await setup()
    t.client.pairDiscovered(1, t.relayId, null, 'MacBook Air')
    await expect.poll(() => t.states.at(-1)?.state).toBe('compare')
    t.client.matchPairing(1, false)
    expect(t.states.at(-1)).toEqual({ state: 'failed', reason: 'void' })
    await expect
      .poll(() => t.events.at(-1)?.request)
      .toEqual({
        state: 'closed',
        reason: 'cancelled',
      })
  })

  it("lists nothing of another account's hosts, and a host off the list is offline", async () => {
    const t = await setup('stranger-token')
    expect(await t.client.discover(null)).toEqual({ state: 'ok', hosts: [] })
    t.client.pairDiscovered(1, t.relayId, null, 'MacBook Air')
    await expect.poll(() => t.states.at(-1)).toEqual({ state: 'failed', reason: 'host_offline' })
  })

  it('takes the host off the list once it no longer lets devices find it', async () => {
    const t = await setup()
    t.discovery.setEnabled(false)
    t.relay.profileChanged()
    await expect.poll(() => t.relays.relay(MAIN).hosts.get(t.relayId)?.profile).toBeNull()
    expect(await t.client.discover(null)).toEqual({ state: 'ok', hosts: [] })
  })
})
