// Relay regions end to end on the test relay: a host signing in where the region rules say, pins
// handed to the sockets of regions at an IP address, its leg timed on each control socket, a
// region that drains left once no device is joined through it, and the channel messages by which
// a host and a device tell each other their regions.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeRelays } from '@shared/remote/fake-relay'
import { generateKeyPair } from '@shared/remote/noise'
import { importRelayKey, newRelaySeed, relayHostId } from '@shared/remote/relay'
import { dialRelay } from '@shared/remote/relay-device'
import { RelayHost } from '@shared/remote/relay-host'
import {
  DRAINED_MS,
  REGIONS_CHANNEL_FEATURE,
  REGION_KEYS,
  hostRegions,
  verifyRegionList,
  type RegionList,
  type RelayPreferMessage,
} from '@shared/remote/relay-regions'
import vectors from '@shared/remote/relay-vectors.json'
import { ActivityLog } from './activity'
import { HostClient, type ClientRegions } from './client'
import { DeviceStore } from './devices'
import { HostStore } from './hosts'
import { PairingCodes } from './pairing'
import { RemoteServer, type ServerRegions } from './server'
import { memoryPorts, memoryTransports } from './testing/memory'

const MAIN = vectors.regions.main
const KEYS = { ...REGION_KEYS, [vectors.regions.key.id]: vectors.regions.key.publicKey }
const HK = 'https://hk-1.relay.kettu.sh'
const SH = 'https://203.0.113.7:7443'
const PIN = vectors.regions.list.regions[1]!.pin!
const log = (): void => {}
const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kettu-relay-regions-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

async function ownList(): Promise<RegionList> {
  return (await verifyRegionList(vectors.regions.signed, MAIN, KEYS))!
}

async function host(options: { leaveMs?: number } = {}) {
  const relays = new FakeRelays()
  relays.accounts.set('relay-token', 'account')
  const key = await importRelayKey(await newRelaySeed())
  const id = await relayHostId(key.publicKey)
  const accepted: WebSocket[] = []
  const drained: string[] = []
  let now = 1_000
  const relay = new RelayHost({
    main: MAIN,
    id,
    key,
    openSocket: relays.openSocket,
    fetchInfo: relays.fetchInfo,
    accepted: (socket) => accepted.push(socket),
    changed: () => {},
    drained: (region) => drained.push(region.id),
    log,
    now: () => (now += 7),
    ...(options.leaveMs ? { timings: { leaveMs: options.leaveMs } } : {}),
  })
  relay.setPlan(hostRegions({ main: MAIN, own: await ownList(), preferred: [] }))
  relay.start()
  relay.setToken('relay-token')
  cleanups.push(() => relay.stop())
  await expect
    .poll(() => relay.status.map((r) => r.connection.state))
    .toEqual(['connected', 'connected', 'connected'])
  return { relays, relay, id, accepted, drained, advance: (ms: number) => (now += ms) }
}

describe('a host on the relay regions', () => {
  it('signs in where the rules say, through the pin of a region at an IP address', async () => {
    const t = await host()
    expect(t.relay.relays).toEqual([
      { id: 'main', url: MAIN },
      { id: 'hk-1', url: HK, name: 'Hong Kong' },
      { id: 'sh-1', url: SH, name: 'Shanghai', pin: PIN },
    ])
    for (const url of [MAIN, HK, SH]) expect(t.relays.relay(url).hosts.has(t.id)).toBe(true)
    expect(t.relays.pins.get(`wss://203.0.113.7:7443/v1/hosts/${t.id}`)).toBe(PIN)
    expect([...t.relays.pins.keys()].every((url) => url.includes('203.0.113.7'))).toBe(true)
    // The first ping goes out as each signs in, for the host's leg.
    await expect.poll(() => t.relay.legs().map((leg) => leg.hostRtt)).toEqual([7, 7, 7])
  })

  it('节点仅更改展示名称时直接更新状态而不重建连接', async () => {
    const t = await host()
    const before = t.relays.relay(SH).hosts.get(t.id)
    expect(before).toBeDefined()
    t.relay.setPlan([
      { id: 'main', url: MAIN },
      { id: 'hk-1', url: HK, name: 'Hong Kong' },
      { id: 'sh-1', url: SH, name: '上海一区', pin: PIN },
    ])
    expect(t.relay.status.find((r) => r.id === 'sh-1')?.name).toBe('上海一区')
    expect(t.relays.relay(SH).hosts.get(t.id)).toBe(before)
  })

  it('leaves a region that drains at once when no device is joined through it', async () => {
    const t = await host()
    t.relays.relay(HK).drain()
    await expect.poll(() => t.drained).toEqual(['hk-1'])
    await expect.poll(() => t.relays.relay(HK).hosts.has(t.id)).toBe(false)
    expect(t.relay.relays.map((r) => r.id)).toEqual(['main', 'sh-1'])
    // Not signed in to again while it drains, whatever the plan says.
    t.relay.setPlan(hostRegions({ main: MAIN, own: await ownList(), preferred: [] }))
    expect(t.relay.relays.map((r) => r.id)).toEqual(['main', 'sh-1'])
  })

  it('signs in again to a region that drained once it was passed over long enough', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    cleanups.push(() => void vi.useRealTimers())
    const t = await host()
    t.relays.relay(HK).drain()
    await expect.poll(() => t.relay.relays.map((r) => r.id)).toEqual(['main', 'sh-1'])
    // Nothing else changes meanwhile: the plan is the same as before the drain.
    t.advance(DRAINED_MS)
    await vi.advanceTimersByTimeAsync(DRAINED_MS)
    await expect
      .poll(() => t.relay.status.map((r) => `${r.id}:${r.connection.state}`))
      .toEqual(['main:connected', 'hk-1:connected', 'sh-1:connected'])
  })

  it('stays on a draining region until its last device goes, and the device hears it drain', async () => {
    const t = await host()
    const heard: string[] = []
    const result = await dialRelay({
      relays: [{ url: SH, pin: PIN }],
      id: t.id,
      token: 'relay-token',
      openSocket: t.relays.openSocket,
      timeoutMs: 5000,
      drained: (url) => heard.push(url),
    })
    expect(result.kind).toBe('joined')
    await expect.poll(() => t.accepted.length).toBe(1)

    t.relays.relay(SH).drain()
    await expect.poll(() => heard).toEqual([SH])
    await expect.poll(() => t.relay.relays.map((r) => r.id)).toEqual(['main', 'hk-1'])
    // Still there for the device joined through it, taking no new one.
    expect(t.relays.relay(SH).hosts.has(t.id)).toBe(true)
    if (result.kind === 'joined') result.socket.close()
    await expect.poll(() => t.relays.relay(SH).hosts.has(t.id)).toBe(false)
  })

  it('leaves a draining region after a while even with a device joined', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    cleanups.push(() => void vi.useRealTimers())
    const t = await host({ leaveMs: 60_000 })
    const result = await dialRelay({
      relays: [{ url: HK }],
      id: t.id,
      token: 'relay-token',
      openSocket: t.relays.openSocket,
      timeoutMs: 5000,
    })
    expect(result.kind).toBe('joined')
    await expect.poll(() => t.accepted.length).toBe(1)
    t.relays.relay(HK).drain()
    await expect.poll(() => t.drained).toEqual(['hk-1'])
    expect(t.relays.relay(HK).hosts.has(t.id)).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(t.relays.relay(HK).hosts.has(t.id)).toBe(false)
  })

  it('signs in again through a region whose pin changed', async () => {
    const t = await host()
    const socketUrl = `wss://203.0.113.7:7443/v1/hosts/${t.id}`
    const rotated = 'Q'.repeat(43)
    t.relay.setPlan([
      { id: 'main', url: MAIN },
      { id: 'hk-1', url: HK },
      { id: 'sh-1', url: SH, pin: rotated },
    ])
    await expect.poll(() => t.relays.pins.get(socketUrl)).toBe(rotated)
    await expect
      .poll(() => t.relay.status.map((r) => [r.id, r.pin, r.connection.state]))
      .toEqual([
        ['main', undefined, 'connected'],
        ['hk-1', undefined, 'connected'],
        ['sh-1', rotated, 'connected'],
      ])
  })

  it('renews its token on no region it is leaving, so the access token stays on the main relay', async () => {
    const t = await host()
    t.relays.accounts.set('access-token', 'account')
    const result = await dialRelay({
      relays: [{ url: SH, pin: PIN }],
      id: t.id,
      token: 'relay-token',
      openSocket: t.relays.openSocket,
      timeoutMs: 5000,
    })
    expect(result.kind).toBe('joined')
    await expect.poll(() => t.accepted.length).toBe(1)

    // The relay token is gone: the main relay alone, with the access token.
    t.relay.setPlan([{ id: 'main', url: MAIN }])
    t.relay.setToken('access-token')
    await expect.poll(() => t.relays.relay(MAIN).renewed).toEqual(['access-token'])
    // Still there for the device joined through it, on the relay token it signed in with.
    expect(t.relays.relay(SH).hosts.has(t.id)).toBe(true)
    expect(t.relays.relay(SH).renewed).toEqual([])
    expect(t.relays.relay(HK).renewed).toEqual([])
  })
})

describe('the channel messages for regions', () => {
  async function pair(options: { offered: boolean; reads: boolean }) {
    const hostKey = await generateKeyPair()
    const deviceKey = await generateKeyPair()
    const hostDir = tempDir()
    const devices = await DeviceStore.load(hostDir, log)
    await devices.add({
      publicKey: Buffer.from(deviceKey.publicKey).toString('base64'),
      name: 'Laptop',
      kind: 'desktop',
      platform: 'darwin',
      model: '',
    })
    const prefers: [string, unknown][] = []
    const seen: string[] = []
    let rtt = 40
    let more: { id: string; rtt: number | null }[] = []
    const serverRegions: ServerRegions = {
      offered: () => options.offered,
      message: () => ({
        type: 'relay.regions',
        list: vectors.regions.signed,
        regions: [{ id: 'main', rtt: 180 }, { id: 'hk-1', rtt }, ...more],
      }),
      preferred: (deviceId, value) => prefers.push([deviceId, value]),
      seen: (deviceId) => seen.push(deviceId),
    }
    const server = new RemoteServer({
      staticKey: hostKey,
      devices,
      activity: await ActivityLog.load(hostDir, log),
      pairing: new PairingCodes({
        hostKey: hostKey.publicKey,
        addresses: () => [],
        send: () => {},
      }),
      host: { name: 'Studio', platform: 'darwin', version: '0.0.0-test' },
      uploads: path.join(hostDir, 'uploads'),
      openAgentPort: async () => memoryPorts()[0],
      regions: serverRegions,
      changed: () => {},
      log,
    })
    cleanups.push(() => server.stop('stopping'))

    const hosts = await HostStore.load(tempDir(), log)
    const known = (await hosts.add({
      publicKey: Buffer.from(hostKey.publicKey).toString('base64'),
      name: 'Studio',
      platform: 'darwin',
      version: '0.0.0-test',
      addresses: [{ host: '192.168.1.8', port: 47821 }],
      deviceName: 'Laptop',
    }))!
    const received: [string, unknown][] = []
    const prefer: RelayPreferMessage = {
      type: 'relay.prefer',
      regions: ['hk-1'],
      list: vectors.regions.signed,
    }
    const clientRegions: ClientRegions = {
      hostRegions: async (hostId, value) => void received.push([hostId, value]),
      ranked: () => null,
      preferMessage: () => prefer,
      dialed: () => {},
      drained: () => {},
      allowed: (urls) => urls,
    }
    const changed: string[] = []
    const client = new HostClient({
      key: deviceKey,
      hosts,
      client: { kind: 'desktop', version: '1.0.0', platform: 'macOS 26.1' },
      name: () => 'Laptop',
      changed: () => {},
      pairing: () => {},
      log,
      connect: async () => {
        const [deviceEnd, hostEnd] = memoryTransports()
        server.accept(hostEnd)
        return deviceEnd
      },
      ...(options.reads
        ? {
            relay: {
              main: MAIN,
              token: () => null,
              openSocket: () => {
                throw new Error('No relay in this test')
              },
              regions: clientRegions,
            },
          }
        : {}),
      regionsChanged: (hostId) => changed.push(hostId),
    })
    cleanups.push(() => client.stop())
    client.start()
    await expect.poll(() => client.list()[0]?.connection.state).toBe('online')
    return {
      server,
      known,
      received,
      prefers,
      seen,
      changed,
      setRtt: (ms: number) => (rtt = ms),
      signIn: (id: string) => (more = [...more, { id, rtt: null }]),
    }
  }

  it('tells a device that reads them the host’s regions, and the host the device’s fastest', async () => {
    const t = await pair({ offered: true, reads: true })
    await expect.poll(() => t.received.length).toBe(1)
    expect(t.received[0]).toEqual([
      t.known.id,
      {
        type: 'relay.regions',
        list: vectors.regions.signed,
        regions: [
          { id: 'main', rtt: 180 },
          { id: 'hk-1', rtt: 40 },
        ],
      },
    ])
    await expect.poll(() => t.changed).toEqual([t.known.id])
    await expect.poll(() => t.prefers.length).toBe(1)
    expect(t.prefers[0]![1]).toMatchObject({ type: 'relay.prefer', regions: ['hk-1'] })
    expect(t.seen).toHaveLength(1)

    // A change of the round trip alone waits for a minute; nothing else changed, nothing goes.
    t.server.regionsChanged()
    t.setRtt(90)
    t.server.regionsChanged()
    await new Promise((done) => setTimeout(done, 50))
    expect(t.received).toHaveLength(1)
    // A region signed in to meanwhile goes at once, the new round trip with it.
    t.signIn('sh-1')
    t.server.regionsChanged()
    await expect.poll(() => t.received.length).toBe(2)
    expect(t.received[1]![1]).toMatchObject({
      regions: [
        { id: 'main', rtt: 180 },
        { id: 'hk-1', rtt: 90 },
        { id: 'sh-1', rtt: null },
      ],
    })
  })

  it('names the feature only with a list, and sends the regions only to a device that reads them', async () => {
    const quiet = await pair({ offered: true, reads: false })
    await new Promise((done) => setTimeout(done, 50))
    expect(quiet.prefers).toEqual([])
    expect(quiet.seen).toEqual([])

    const none = await pair({ offered: false, reads: true })
    await new Promise((done) => setTimeout(done, 50))
    expect(none.received).toEqual([])
    expect(none.prefers).toEqual([])
  })

  it('names the feature in the hello of a device with regions alone', async () => {
    const client = new HostClient({
      key: await generateKeyPair(),
      hosts: await HostStore.load(tempDir(), log),
      client: { kind: 'desktop', version: '1.0.0', platform: 'macOS 26.1' },
      name: () => 'Laptop',
      changed: () => {},
      pairing: () => {},
      log,
    })
    expect(client.hello().features).not.toContain(REGIONS_CHANNEL_FEATURE)
  })
})
