// Client-side relay node selection: HostClient preference routing, own-relay RTT probing with
// strict credential isolation, locked background path comparison (with LAN direct still winning),
// immediate switching on preference change, and shared HostLink preference enforcement.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeRelays } from '@shared/remote/fake-relay'
import { parseClientRelayNodes, type HostConnection } from '@shared/remote/hosts'
import { hello, HostLink, type LinkRoute } from '@shared/remote/link'
import { generateKeyPair } from '@shared/remote/noise'
import type { DirectAddress } from '@shared/remote/protocol'
import {
  importRelayKey,
  newRelaySeed,
  relayHostId,
  type HostRelay,
  type RelayRegion,
} from '@shared/remote/relay'
import { RelayHost } from '@shared/remote/relay-host'
import {
  REGIONS_CHANNEL_FEATURE,
  REGION_KEYS,
  parseRelayPreference,
  type RankedRegion,
  type RelayPreference,
} from '@shared/remote/relay-regions'
import { DeviceRegions, RegionSource, RegionTimes } from '@shared/remote/region-source'
import vectors from '@shared/remote/relay-vectors.json'
import type { Transport } from '@shared/remote/transport'
import { webSocketTransport } from '@shared/remote/websocket-transport'
import { ActivityLog } from './activity'
import { HostClient, type ClientRegions } from './client'
import { DeviceStore } from './devices'
import { DiscoveryRequests } from './discovery'
import { HostStore } from './hosts'
import { PairingCodes } from './pairing'
import { RemoteServer, type ServerRegions } from './server'
import { memoryPorts, memoryTransports } from './testing/memory'

const MAIN = vectors.regions.main
const HK = 'https://hk-1.relay.kettu.sh'
const SH = 'https://203.0.113.7:7443'
const PIN = vectors.regions.list.regions[1]!.pin!
const OWN = 'https://own.example.com'
const OWN_ACCESS_KEY = 'own-relay-secret-access-key-0123456789'
const KEYS = { ...REGION_KEYS, [vectors.regions.key.id]: vectors.regions.key.publicKey }
const LAN: DirectAddress = { host: '192.168.1.9', port: 47821 }
const log = (): void => {}
const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kettu-client-relay-pref-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Adds artificial receive latency so path comparison measures distinct RTTs. */
function delayed(transport: Transport, ms: number): Transport {
  if (ms <= 0) return transport
  return {
    ...transport,
    onMessage: (listener) =>
      transport.onMessage((message) => void setTimeout(() => listener(message), ms)),
    onClose: (listener) => transport.onClose(() => void setTimeout(listener, ms)),
  }
}

async function setupMultiRelay(
  options: {
    initialPreference?: string
    deviceRtts?: Record<string, number>
    hostOwnRtt?: number | null
    hostRegionRtts?: { id: string; rtt: number | null }[]
    latencyMs?: Record<string, number>
  } = {},
) {
  const relays = new FakeRelays()
  relays.accounts.set('host-token', 'account')
  relays.accounts.set('client-token', 'account')
  relays.relay(OWN).useAccessKey(OWN_ACCESS_KEY)

  const hostDir = tempDir()
  const hostKey = await generateKeyPair()
  const deviceKey = await generateKeyPair()
  const relayKey = await importRelayKey(await newRelaySeed())
  const relayId = await relayHostId(relayKey.publicKey)
  const devices = await DeviceStore.load(hostDir, log)
  await devices.add({
    publicKey: Buffer.from(deviceKey.publicKey).toString('base64'),
    name: 'Laptop',
    kind: 'desktop',
    platform: 'darwin',
    model: '',
  })

  const hostRelay: HostRelay = {
    id: relayId,
    urls: [MAIN, HK],
    own: { url: OWN },
  }
  const receivedPrefers: unknown[] = []
  const hostRegionRtts = options.hostRegionRtts ?? [
    { id: 'main', rtt: 120 },
    { id: 'hk-1', rtt: 20 },
    { id: 'sh-1', rtt: 60 },
  ]
  const serverRegions: ServerRegions = {
    offered: () => true,
    message: () => ({
      type: 'relay.regions',
      list: vectors.regions.signed,
      regions: hostRegionRtts,
    }),
    ownMessage: () => ({
      type: 'relay.own',
      own: { url: OWN, rtt: options.hostOwnRtt ?? 10 },
    }),
    preferred: (_deviceId, value) => receivedPrefers.push(value),
    seen: () => {},
  }

  const server = new RemoteServer({
    staticKey: hostKey,
    devices,
    activity: await ActivityLog.load(hostDir, log),
    pairing: new PairingCodes({ hostKey: hostKey.publicKey, addresses: () => [], send: () => {} }),
    discovery: new DiscoveryRequests({ send: () => {} }),
    host: { name: 'Studio', platform: 'darwin', version: '0.0.0-test' },
    uploads: path.join(hostDir, 'uploads'),
    openAgentPort: async () => memoryPorts()[0],
    relay: () => hostRelay,
    regions: serverRegions,
    changed: () => {},
    log,
  })

  const latency = options.latencyMs ?? {}
  const acceptFrom = (socket: WebSocket, origin: string) =>
    void webSocketTransport(socket, true).then((transport) =>
      server.accept(delayed(transport, latency[origin] ?? 0), 'relay'),
    )

  const officialHost = new RelayHost({
    main: MAIN,
    id: relayId,
    key: relayKey,
    openSocket: relays.openSocket,
    fetchInfo: relays.fetchInfo,
    accepted: (socket, origin) => acceptFrom(socket, origin),
    changed: () => {},
    log,
  })
  officialHost.setPlan([
    { id: 'main', url: MAIN },
    { id: 'hk-1', url: HK, name: 'Hong Kong' },
    { id: 'sh-1', url: SH, name: 'Shanghai', pin: PIN },
  ])
  officialHost.start()
  officialHost.setToken('host-token')

  const ownHost = new RelayHost({
    main: OWN,
    id: relayId,
    key: relayKey,
    own: { id: 'own', url: OWN },
    openSocket: relays.openSocket,
    fetchInfo: relays.fetchInfo,
    accepted: (socket) => acceptFrom(socket, OWN),
    changed: () => {},
    log,
  })
  ownHost.start()
  ownHost.setToken(OWN_ACCESS_KEY)

  cleanups.push(async () => {
    officialHost.stop()
    ownHost.stop()
    await server.stop('stopping')
  })

  await expect
    .poll(
      () =>
        relays.relay(MAIN).hosts.has(relayId) &&
        relays.relay(HK).hosts.has(relayId) &&
        relays.relay(SH).hosts.has(relayId) &&
        relays.relay(OWN).hosts.has(relayId),
      { timeout: 15_000 },
    )
    .toBe(true)

  // Client-side DeviceRegions backed by deterministic RTTs.
  let clock = 1_000
  const rtts: Record<string, number> = {
    [MAIN]: 100,
    [HK]: 15,
    [SH]: 60,
    [OWN]: 8,
    ...options.deviceRtts,
  }
  const source = new RegionSource({
    main: MAIN,
    keys: KEYS,
    saved: { signed: vectors.regions.signed, etag: null, serial: vectors.regions.list.serial },
    fetchList: async () => ({ status: 304, etag: null, body: null }),
    changed: () => {},
    log: () => {},
    now: () => clock,
  })
  await source.load()
  const times = new RegionTimes({
    ping: async (region) => {
      const ms = rtts[region.url]
      if (ms === undefined) throw new Error('unreachable')
      clock += ms
    },
    concurrency: 1,
    changed: () => {},
    now: () => clock,
  })
  const deviceRegions = new DeviceRegions({
    source,
    times,
    pinned: true,
    preference: parseRelayPreference(options.initialPreference),
    now: () => clock,
  })
  await times.measure([...deviceRegions.ownRegions(), { id: 'own', url: OWN }], true)

  const measuredOwnCalls: RelayRegion[][] = []
  const clientRegions: ClientRegions = {
    hostRegions: async (hostId, value) => {
      const msg = value as Parameters<DeviceRegions['received']>[1]
      await deviceRegions.received(hostId, msg)
    },
    ranked: (hostId): RankedRegion[] | null => deviceRegions.ranked(hostId),
    preferMessage: () => deviceRegions.prefer(),
    dialed: () => {},
    drained: (url) => deviceRegions.drain(url),
    allowed: (urls) => urls,
    regionId: (url) =>
      source.list?.regions.find((r) => r.url === url)?.id ?? (url === MAIN ? 'main' : null),
    regionName: (url) => source.list?.regions.find((r) => r.url === url)?.name ?? null,
    regionNames: (url) => source.list?.regions.find((r) => r.url === url)?.names ?? null,
    getPreference: () => deviceRegions.getPreference(),
    setPreference: (next: RelayPreference) => deviceRegions.setPreference(next),
    ownRtt: (origin: string) => times.rtt({ url: origin }),
    measureOwnRelays: async (targets, all) => {
      measuredOwnCalls.push([...targets])
      await times.measure(targets, all)
    },
    measureClientRelays: async (ownList = []) => {
      measuredOwnCalls.push([...ownList])
      await times.measure([...deviceRegions.ownRegions(), ...ownList], true)
    },
    officialNodes: () =>
      (source.list?.regions ?? [])
        .filter((r) => r.state === 'active')
        .map((r) => ({
          id: r.id,
          url: r.url,
          name: r.name,
          ...(r.names ? { names: r.names } : {}),
          rtt: times.rtt(r),
        })),
  }

  const lan = { up: false }
  const hosts = await HostStore.load(tempDir(), log)
  const host = (await hosts.add({
    publicKey: Buffer.from(hostKey.publicKey).toString('base64'),
    name: 'Studio',
    platform: 'darwin',
    version: '0.0.0-test',
    addresses: [],
    deviceName: 'Laptop',
    relay: hostRelay,
  }))!

  let changes = 0
  const client = new HostClient({
    key: deviceKey,
    hosts,
    client: { kind: 'desktop', version: '1.0.0', platform: 'macOS 26.1' },
    name: () => 'Laptop',
    openMainPort: async () => memoryPorts()[0],
    changed: () => {
      changes++
    },
    pairing: () => {},
    log,
    connect: async (address) => {
      if (!lan.up || address.host !== LAN.host) throw new Error('ECONNREFUSED')
      const [a, b] = memoryTransports()
      server.accept(b, 'direct')
      return a
    },
    relay: {
      main: MAIN,
      token: () => 'client-token',
      openSocket: relays.openSocket,
      fetchJson: relays.fetchJson,
      regions: clientRegions,
    },
    relayPreference: options.initialPreference,
    timeoutMs: 5_000,
    networkCheckMs: null,
  })
  cleanups.push(() => client.stop())

  return {
    relays,
    server,
    hosts,
    host,
    client,
    lan,
    rtts,
    receivedPrefers,
    measuredOwnCalls,
    changes: () => changes,
    connection: (): HostConnection => client.list().find((h) => h.id === host.id)!.connection,
  }
}

describe('HostClient relay preference routing and credential isolation', () => {
  it('ranks official regions and own relay by total RTT in automatic mode and orders manual picks first', async () => {
    const t = await setupMultiRelay({
      deviceRtts: { [MAIN]: 100, [HK]: 15, [SH]: 60, [OWN]: 8 },
      hostOwnRtt: 10,
      hostRegionRtts: [
        { id: 'main', rtt: 120 },
        { id: 'hk-1', rtt: 20 },
        { id: 'sh-1', rtt: 60 },
      ],
    })
    // Seed ranked regions and host-side own relay RTT.
    await t.client.options.relay!.regions!.hostRegions(t.host.id, {
      type: 'relay.regions',
      list: vectors.regions.signed,
      regions: [
        { id: 'main', rtt: 120 },
        { id: 'hk-1', rtt: 20 },
        { id: 'sh-1', rtt: 60 },
      ],
    })
    t.client.setOwnRelay(t.host.id, { url: OWN, hostRtt: 10 })

    // Automatic: OWN (8 + 10 = 18 ms) beats HK (15 + 20 = 35 ms), SH (120 ms), MAIN (220 ms).
    expect(t.client.regionRoutes(t.host.relay, t.host.id).map((r) => [r.url, r.rtt])).toEqual([
      [OWN, 18],
      [HK, 35],
      [SH, 120],
      [MAIN, 220],
    ])

    // Manual official:sh-1 places SH first, official regions next, own last as fallback.
    t.client.setRelayPreference('official:sh-1')
    expect(t.client.regionRoutes(t.host.relay, t.host.id).map((r) => r.url)).toEqual([
      SH,
      HK,
      MAIN,
      OWN,
    ])

    // Manual own puts OWN first and official regions as fallback.
    t.client.setRelayPreference(`own:${OWN}`)
    expect(t.client.regionRoutes(t.host.relay, t.host.id).map((r) => r.url)).toEqual([
      OWN,
      HK,
      SH,
      MAIN,
    ])

    // Switching back to automatic restores RTT ordering; verify slower own relay sorts behind HK.
    t.client.setOwnRelay(t.host.id, { url: OWN, hostRtt: 80 })
    t.client.setRelayPreference('auto')
    expect(t.client.regionRoutes(t.host.relay, t.host.id).map((r) => [r.url, r.rtt])).toEqual([
      [HK, 35],
      [OWN, 88],
      [SH, 120],
      [MAIN, 220],
    ])
  })

  it(
    'switches immediately on setRelayPreference, locks against slower/faster background relays, never leaks tokens to own relay, and lets LAN win',
    { timeout: 30_000 },
    async () => {
      const t = await setupMultiRelay({
        initialPreference: 'official:main',
        // Make MAIN slow (90 ms) and HK fast (0 ms) so automatic comparison would eagerly switch away.
        latencyMs: { [MAIN]: 90, [HK]: 0, [SH]: 80, [OWN]: 0 },
      })

      t.client.start()
      await expect.poll(() => t.connection().state, { timeout: 15_000 }).toBe('online')
      expect(t.connection()).toMatchObject({ state: 'online', relay: MAIN })

      // Trigger background comparison (wake): manual lock on official:main must NOT switch to faster HK or OWN.
      t.client.resume()
      await new Promise((resolve) => setTimeout(resolve, 250))
      expect(t.connection()).toMatchObject({ state: 'online', relay: MAIN })

      // Switch preference to own relay: moves immediately with strictly null token sent to own relay.
      t.client.setRelayPreference(`own:${OWN}`)
      await expect
        .poll(() => t.connection(), { timeout: 15_000 })
        .toMatchObject({ state: 'online', relay: OWN, own: true })
      expect(t.relays.relay(OWN).deviceTokens.length).toBeGreaterThan(0)
      expect(t.relays.relay(OWN).deviceTokens.every((tok) => tok === null)).toBe(true)

      // Switch preference to slower official:sh-1: moves immediately (bypassing MOVE_RATIO) and announces relay.prefer.
      const prefersBefore = t.receivedPrefers.length
      t.client.setRelayPreference('official:sh-1')
      await expect
        .poll(() => t.connection(), { timeout: 15_000 })
        .toMatchObject({ state: 'online', relay: SH })
      expect(t.receivedPrefers.length).toBeGreaterThan(prefersBefore)
      const lastPrefer = t.receivedPrefers.at(-1) as { regions?: string[] }
      expect(lastPrefer.regions?.[0]).toBe('sh-1')

      // ClientRelayNodes snapshot reflects active preference, inUse flag, and round-trips through parser.
      const nodes = t.client.relayNodes()
      expect(nodes.preference).toBe('official:sh-1')
      expect(nodes.official.find((n) => n.id === 'sh-1')?.inUse).toBe(true)
      expect(nodes.official.find((n) => n.id === 'hk-1')?.inUse).toBe(false)
      expect(nodes.own).toEqual([{ origin: OWN, rtt: 8, inUse: false }])
      expect(parseClientRelayNodes(nodes)).toEqual(nodes)

      // LAN direct always wins over manual relay preference when available.
      t.lan.up = true
      t.client.setAddresses(t.host.id, [LAN])
      t.client.resume()
      await expect
        .poll(() => t.connection(), { timeout: 15_000 })
        .toMatchObject({ state: 'online', address: LAN })

      // measureRelays triggers fresh RTT probing of both official and own relays and updates snapshot.
      const beforeChanges = t.changes()
      await t.client.measureRelays()
      expect(t.measuredOwnCalls.some((list) => list.some((r) => r.url === OWN))).toBe(true)
      expect(t.changes()).toBeGreaterThan(beforeChanges)
    },
  )
})

describe('shared HostLink manual relay preference locking', () => {
  it(
    'stays locked on the preferred relay during background comparison and switches immediately on recheckRoutes',
    { timeout: 20_000 },
    async () => {
      const hostKey = await generateKeyPair()
      const deviceKey = await generateKeyPair()
      const hostDir = tempDir()
      const devices = await DeviceStore.load(hostDir, log)
      await devices.add({
        publicKey: Buffer.from(deviceKey.publicKey).toString('base64'),
        name: 'Browser',
        kind: 'web',
        platform: 'macos',
        model: 'Chrome',
      })
      const server = new RemoteServer({
        staticKey: hostKey,
        devices,
        activity: await ActivityLog.load(hostDir, log),
        pairing: new PairingCodes({
          hostKey: hostKey.publicKey,
          addresses: () => [],
          send: () => {},
        }),
        discovery: new DiscoveryRequests({ send: () => {} }),
        host: { name: 'Studio', platform: 'darwin', version: '0.0.0-test' },
        uploads: path.join(hostDir, 'uploads'),
        openAgentPort: async () => memoryPorts()[0],
        changed: () => {},
        log,
      })
      cleanups.push(() => server.stop('stopping'))

      const dialRoute = (ms: number) => async (): Promise<Transport> => {
        const [clientSide, serverSide] = memoryTransports()
        server.accept(delayed(serverSide, ms), 'relay')
        return clientSide
      }

      const routes: LinkRoute[] = [
        { key: `relay ${MAIN}`, relay: true, dial: dialRoute(90) },
        { key: `relay ${HK}`, relay: true, dial: dialRoute(0) },
      ]
      let preferred: string | null = `relay ${MAIN}`
      const observedRoutes: (string | null)[] = []

      const link = new HostLink({
        dial: routes[0]!.dial,
        routes: () => routes,
        preferredRelay: () => preferred,
        onRoute: (route) => observedRoutes.push(route?.key ?? null),
        hostKey: hostKey.publicKey,
        key: deviceKey,
        hello: {
          ...hello({ kind: 'web', version: '1.0.0', platform: 'macos' }),
          features: [REGIONS_CHANNEL_FEATURE],
        },
        retryDelay: () => 50,
      })
      cleanups.push(() => link.stop())

      link.start()
      await expect.poll(() => link.state.kind, { timeout: 10_000 }).toBe('connected')
      // Must connect to preferred slow MAIN rather than racing faster HK.
      expect(link.currentRoute?.key).toBe(`relay ${MAIN}`)

      // Background wake comparison must NOT move off locked MAIN onto faster HK.
      link.wake()
      await new Promise((resolve) => setTimeout(resolve, 250))
      expect(link.currentRoute?.key).toBe(`relay ${MAIN}`)

      // Changing preference to HK and rechecking switches immediately.
      preferred = `relay ${HK}`
      link.recheckRoutes()
      await expect.poll(() => link.currentRoute?.key, { timeout: 10_000 }).toBe(`relay ${HK}`)
      expect(observedRoutes).toContain(`relay ${MAIN}`)
      expect(observedRoutes).toContain(`relay ${HK}`)

      // Switching back to slower MAIN also moves immediately (bypassing MOVE_RATIO).
      preferred = `relay ${MAIN}`
      link.recheckRoutes()
      await expect.poll(() => link.currentRoute?.key, { timeout: 10_000 }).toBe(`relay ${MAIN}`)
    },
  )
})

describe('RemoteRegions own-relay RTT probing isolation', () => {
  it('measures own relays without authorization headers and excludes them from official stats', async () => {
    const requests: { url: string; headers?: Record<string, string>; pin?: string }[] = []
    vi.resetModules()
    vi.doMock('./relay-net', () => ({
      jsonOf: (text: string) => JSON.parse(text) as unknown,
      relayRequest: async (
        url: string,
        request: { headers?: Record<string, string>; pin?: string },
      ) => {
        requests.push({ url, headers: request.headers, pin: request.pin })
        if (url.endsWith('/v1/ping')) {
          return { status: 204, header: () => null, text: '' }
        }
        return { status: 404, header: () => null, text: '' }
      },
    }))
    const { RemoteRegions } = await import('./relay-regions')
    const dir = tempDir()
    const loaded = await RemoteRegions.load({
      userDataPath: dir,
      main: MAIN,
      app: 'desktop',
      keys: KEYS,
      device: true,
      accessToken: () => null,
      relayToken: () => null,
      relayOn: () => false,
      plan: () => {},
      hostChanged: () => {},
      timesChanged: () => {},
      log,
    })
    cleanups.push(async () => {
      await loaded.stop()
      vi.doUnmock('./relay-net')
    })

    await loaded.measureOwnRelays([{ id: 'own', url: OWN, pin: PIN }], true)
    expect(loaded.ownRtt(OWN)).toEqual(expect.any(Number))
    expect(requests.length).toBe(2)
    for (const req of requests) {
      expect(req.url).toBe(`${OWN}/v1/ping`)
      expect(req.pin).toBe(PIN)
      expect(req.headers?.authorization).toBeUndefined()
    }
  })
})
