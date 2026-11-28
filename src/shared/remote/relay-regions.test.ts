import { describe, expect, it } from 'vitest'
import vectors from './relay-vectors.json'
import {
  REGION_KEYS,
  RegionSerial,
  fastestRegions,
  hostRegions,
  isPin,
  localizedRegionName,
  parseRegionNames,
  parseRegionPayload,
  parseRelayPrefer,
  parseRelayPreference,
  parseRelayRegions,
  rankRegions,
  regionKeys,
  regionOrigin,
  serializeRelayPreference,
  verifyRegionList,
  type ListedRegion,
  type RegionList,
} from './relay-regions'
import { decodeRelayBytes } from './relay'
import { parseRelayRegionStatuses, parseRelayStatuses } from './relay-host'
import { RelayStats, localDay, reportBody } from './relay-report'
import { relayReport } from './status'

const { regions: v } = vectors
const KEYS = { ...REGION_KEYS, [v.key.id]: v.key.publicKey }
const MAIN = v.main

async function list(): Promise<RegionList> {
  return (await verifyRegionList(v.signed, MAIN, KEYS))!
}

describe('the signed region list', () => {
  it('ships the current and the next key, each an Ed25519 public key', () => {
    expect(Object.keys(REGION_KEYS)).toEqual(['r1', 'r2'])
    for (const key of Object.values(REGION_KEYS)) expect(decodeRelayBytes(key)?.length).toBe(32)
  })

  it('verifies a list signed with a key it knows, and reads it', async () => {
    expect(await verifyRegionList(v.signed, MAIN, KEYS)).toEqual(v.list)
  })

  it('refuses a list from an unknown key, with a bad signature or a changed payload', async () => {
    // The test key is no built-in one.
    expect(await verifyRegionList(v.signed, MAIN)).toBeNull()
    for (const signed of Object.values(v.refused)) {
      expect(await verifyRegionList(signed, MAIN, KEYS)).toBeNull()
    }
    expect(await verifyRegionList({ ...v.signed, key: 'toString' }, MAIN, KEYS)).toBeNull()
    expect(await verifyRegionList({ ...v.signed, payload: 7 }, MAIN, KEYS)).toBeNull()
  })

  it('takes a region at an IP address only with a pin, over https with its port given', async () => {
    const kept = (await verifyRegionList(v.regionRules.signed, MAIN, KEYS))!
    expect(kept.regions.map((region) => region.id)).toEqual(v.regionRules.kept)
    expect(kept.stun).toEqual(v.regionRules.stun)
    const pin = v.list.regions[1]!.pin!
    expect(isPin(pin)).toBe(true)
    expect(regionOrigin('https://203.0.113.7:7443/', pin, MAIN)).toBe('https://203.0.113.7:7443')
    expect(regionOrigin('https://[2001:db8::7]:7443', pin, MAIN)).toBe('https://[2001:db8::7]:7443')
    expect(regionOrigin('https://203.0.113.7', pin, MAIN)).toBeNull()
    expect(regionOrigin('https://203.0.113.7:7443', null, MAIN)).toBeNull()
    expect(regionOrigin('https://hk.relay.kettu.sh:7443', pin, MAIN)).toBeNull()
    expect(regionOrigin('https://hk.relay.kettu.sh', null, MAIN)).toBe('https://hk.relay.kettu.sh')
    expect(regionOrigin('https://relay.example.com', null, MAIN)).toBeNull()
    // A development relay vouches for no domain region; a pinned one is still taken.
    expect(regionOrigin('https://203.0.113.7:7443', pin, 'http://localhost:8798')).not.toBeNull()
  })

  it('takes no lower serial than the newest it saw, and an equal one from another place', async () => {
    const serial = new RegionSerial()
    const lower = (await verifyRegionList(v.lowerSerial, MAIN, KEYS))!
    expect(serial.take((await list()).serial)).toBe(true)
    expect(serial.take(lower.serial)).toBe(false)
    expect(serial.take(42)).toBe(true)
    expect(serial.current).toBe(42)
  })

  it('adds development keys only as well-formed id=key pairs, and never for the project relay', () => {
    const local = 'http://relay.kettu.localhost:8798'
    const pair = `${v.key.id}=${v.key.publicKey}`
    expect(regionKeys(local, `${pair}, bad=AAAA, =x`)).toEqual({
      ...REGION_KEYS,
      t1: v.key.publicKey,
    })
    expect(regionKeys(local, undefined)).toEqual(REGION_KEYS)
    for (const main of [
      'https://relay.kettu.sh',
      'https://relay.kettu.sh/',
      'https://relay.kettu.sh.',
    ]) {
      expect(regionKeys(main, `r1=${v.key.publicKey}`)).toEqual(REGION_KEYS)
    }
  })
})

describe('the regions a host signs in to', () => {
  const region = (id: string, extra: Partial<ListedRegion> = {}): ListedRegion => ({
    id,
    name: id,
    country: null,
    url: `https://${id}.relay.kettu.sh`,
    pin: null,
    state: 'active',
    ...extra,
  })

  it('signs in to the main relay and the first two active regions of its own list', async () => {
    const own = await list()
    expect(hostRegions({ main: MAIN, own, preferred: [] })).toEqual([
      { id: 'main', url: MAIN },
      { id: 'hk-1', url: 'https://hk-1.relay.kettu.sh', name: 'Hong Kong' },
      {
        id: 'sh-1',
        url: 'https://203.0.113.7:7443',
        name: 'Shanghai',
        pin: v.list.regions[1]!.pin,
      },
    ])
  })

  it("adds its devices' preferred regions, at most 8 in all, never a probe or a draining one", async () => {
    const own = await list()
    const preferred = [
      region('tyo-1'),
      region('hk-1', { url: 'https://hk-1.relay.kettu.sh' }),
      region('probe-1', { state: 'probe' }),
      region('gone'),
      ...['a', 'b', 'c', 'd', 'e', 'f'].map((id) => region(id)),
    ]
    const picked = hostRegions({
      main: MAIN,
      own,
      preferred,
      draining: new Set(['https://gone.relay.kettu.sh']),
    })
    expect(picked.map((r) => r.id)).toEqual(['main', 'hk-1', 'sh-1', 'tyo-1', 'a', 'b', 'c', 'd'])
  })

  it('passes over a draining region of its own list for the next one', async () => {
    const own = await list()
    const picked = hostRegions({
      main: MAIN,
      own,
      preferred: [],
      draining: new Set(['https://hk-1.relay.kettu.sh']),
    })
    expect(picked.map((r) => r.id)).toEqual(['main', 'sh-1'])
  })

  it('ranks automatic own-list picks by measured hostRtt ascending when proxy GeoIP order is skewed', () => {
    const own: RegionList = {
      serial: 1,
      issuedAt: 1000,
      place: { country: 'US', asn: null },
      regions: [
        region('main', { url: MAIN }),
        region('la-1'),
        region('hk-1'),
        region('sh-1'),
        region('gz-1'),
        region('probe-1', { state: 'probe' }),
      ],
      stun: [],
    }
    const rtts: Record<string, number | null> = {
      'la-1': 220,
      'hk-1': 180,
      'sh-1': 36,
      'gz-1': 28,
      'probe-1': 5,
    }
    const picked = hostRegions({
      main: MAIN,
      own,
      preferred: [],
      hostRtt: (r) => rtts[r.id] ?? null,
    })
    expect(picked.map((r) => r.id)).toEqual(['main', 'gz-1', 'sh-1'])

    // Known RTTs rank ahead of unmeasured ones; ties preserve list order.
    const partial: Record<string, number | null> = { 'gz-1': 40 }
    expect(
      hostRegions({
        main: MAIN,
        own,
        preferred: [],
        hostRtt: (r) => partial[r.id] ?? null,
      }).map((r) => r.id),
    ).toEqual(['main', 'gz-1', 'la-1'])
  })

  it('uses explicit selected regions in manual mode without device preference overrides', () => {
    const own: RegionList = {
      serial: 1,
      issuedAt: 1000,
      place: { country: 'CN', asn: 4134 },
      regions: [
        region('main', { url: MAIN }),
        region('bj-1'),
        region('sh-1'),
        region('gz-1'),
        region('hk-1'),
        region('probe-1', { state: 'probe' }),
        ...['r1', 'r2', 'r3', 'r4', 'r5', 'r6'].map((id) => region(id)),
      ],
      stun: [],
    }
    const manual = hostRegions({
      main: MAIN,
      own,
      preferred: [region('hk-1'), region('bj-1')],
      draining: new Set(['https://bj-1.relay.kettu.sh']),
      hostRtt: (r) => (r.id === 'hk-1' ? 10 : 90),
      selected: ['main', 'gz-1', 'bj-1', 'probe-1', 'missing', 'sh-1', 'gz-1'],
    })
    expect(manual.map((r) => r.id)).toEqual(['main', 'gz-1', 'sh-1'])

    // Caps manual selection at MAX_REGIONS (8 total including main).
    const capped = hostRegions({
      main: MAIN,
      own,
      preferred: [],
      selected: ['gz-1', 'sh-1', 'hk-1', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6'],
    })
    expect(capped.map((r) => r.id)).toEqual([
      'main',
      'gz-1',
      'sh-1',
      'hk-1',
      'r1',
      'r2',
      'r3',
      'r4',
    ])

    // Empty or null selection falls back to automatic mode.
    expect(
      hostRegions({
        main: MAIN,
        own,
        preferred: [],
        hostRtt: (r) => (r.id === 'gz-1' ? 15 : r.id === 'sh-1' ? 20 : 100),
        selected: [],
      }).map((r) => r.id),
    ).toEqual(['main', 'gz-1', 'sh-1'])
  })
})

describe('RelayPreference parsing and serialization', () => {
  it('parses and serializes automatic, official, and own relay preferences', () => {
    expect(parseRelayPreference('auto')).toEqual({ kind: 'automatic' })
    expect(parseRelayPreference('')).toEqual({ kind: 'automatic' })
    expect(parseRelayPreference(null)).toEqual({ kind: 'automatic' })
    expect(parseRelayPreference(42)).toEqual({ kind: 'automatic' })

    expect(parseRelayPreference('official:gz-1')).toEqual({ kind: 'official', id: 'gz-1' })
    expect(parseRelayPreference('official:main')).toEqual({ kind: 'official', id: 'main' })
    expect(parseRelayPreference('official:BAD_ID')).toEqual({ kind: 'automatic' })
    expect(parseRelayPreference('official:')).toEqual({ kind: 'automatic' })

    expect(parseRelayPreference('own:https://relay.example.com')).toEqual({
      kind: 'own',
      origin: 'https://relay.example.com',
    })
    expect(parseRelayPreference('own:https://relay.example.com:8443/')).toEqual({
      kind: 'own',
      origin: 'https://relay.example.com:8443',
    })
    expect(parseRelayPreference('own:https://relay.example.com/extra')).toEqual({
      kind: 'automatic',
    })
    expect(parseRelayPreference('own:https://user:pass@relay.example.com')).toEqual({
      kind: 'automatic',
    })
    expect(parseRelayPreference('own:ftp://relay.example.com')).toEqual({ kind: 'automatic' })
    expect(parseRelayPreference('unknown:gz-1')).toEqual({ kind: 'automatic' })

    expect(serializeRelayPreference({ kind: 'automatic' })).toBe('auto')
    expect(serializeRelayPreference({ kind: 'official', id: 'sh-1' })).toBe('official:sh-1')
    expect(serializeRelayPreference({ kind: 'official', id: 'INVALID' })).toBe('auto')
    expect(serializeRelayPreference({ kind: 'own', origin: 'https://relay.example.com/' })).toBe(
      'own:https://relay.example.com',
    )
    expect(serializeRelayPreference({ kind: 'own', origin: 'not a url' })).toBe('auto')
  })
})

describe('the channel messages for regions', () => {
  const { channel } = vectors

  it('reads each side’s message and refuses the rest', () => {
    for (const value of channel.regions.valid) expect(parseRelayRegions(value)).toEqual(value)
    for (const value of channel.regions.invalid) expect(parseRelayRegions(value)).toBeNull()
    for (const value of channel.prefer.valid) expect(parseRelayPrefer(value)).toEqual(value)
    for (const value of channel.prefer.invalid) expect(parseRelayPrefer(value)).toBeNull()
  })

  it("ranks a host's regions by both legs, those with an unknown leg last", async () => {
    const own = await list()
    const message = parseRelayRegions(channel.regions.valid[0])!
    const legs = message.regions.map(({ id, rtt }) => {
      const listed = own.regions.find((r) => r.id === id)!
      return { id, url: listed.url, ...(listed.pin ? { pin: listed.pin } : {}), hostRtt: rtt }
    })
    const device = channel.regions.ranked.device as Record<string, number>
    const ranked = rankRegions(legs, (r) => device[r.url] ?? null)
    expect(ranked.map((r) => r.id)).toEqual(channel.regions.ranked.order)
    expect(ranked.map((r) => r.rtt)).toEqual(channel.regions.ranked.rtt)
    expect(ranked[2]!.pin).toBe(v.list.regions[1]!.pin)
  })

  it('prefers the two fastest active regions, leaving out pinned ones in a browser', async () => {
    const own = await list()
    const rtts: Record<string, number> = { 'tyo-2': 1, 'sh-1': 5, 'hk-1': 20, main: 30 }
    const rtt = (r: ListedRegion): number | null => rtts[r.id] ?? null
    expect(fastestRegions(own, rtt, { pinned: true })).toEqual(['sh-1', 'hk-1'])
    expect(fastestRegions(own, rtt, { pinned: false })).toEqual(['hk-1', 'main'])
  })
})

describe('the daily round trip report', () => {
  const { report } = vectors
  const at = (day: string, hour = 12): number => {
    const [y, m, d] = day.split('-').map(Number) as [number, number, number]
    return new Date(y, m - 1, d, hour).getTime()
  }

  it('reports the median and the 90th percentile by nearest rank, null for a region never timed', () => {
    const stats = {
      day: report.body.day,
      regions: {
        'hk-1': { rtts: report.rtts, connects: 12, failures: 1 },
        'sh-1': { rtts: [], connects: 0, failures: 3 },
      },
      p2p: { attempts: 0, opened: 0 },
    }
    expect(reportBody(stats, 'desktop')).toEqual(report.body)
  })

  it('is due once the day is over, once a local day, and only for the day before', () => {
    let now = at('2026-11-14')
    let saved: unknown = null
    const stats = new RelayStats({ save: (state) => (saved = state), now: () => now })
    for (const rtt of report.rtts) stats.sample('hk-1', rtt)
    for (let i = 0; i < 12; i++) stats.connected('hk-1', true)
    stats.connected('hk-1', false)
    for (let i = 0; i < 3; i++) stats.connected('sh-1', false)
    expect(stats.due('desktop')).toBeNull()

    now = at('2026-11-15', 9)
    expect(stats.due('desktop')).toEqual(report.body)
    stats.sent(report.body.day)
    expect(stats.due('desktop')).toBeNull()
    expect(saved).not.toBeNull()

    // A day counted, then nothing until two days later: that day is no longer the day before.
    stats.sample('hk-1', 40)
    now = at('2026-11-17')
    expect(stats.due('desktop')).toBeNull()
    expect(localDay(now)).toBe('2026-11-17')
  })

  it('counts no region whose id is not one', () => {
    const now = at('2026-11-14')
    const stats = new RelayStats({ save: () => {}, now: () => now })
    stats.sample('Not An Id', 40)
    stats.sample('hk-1', 40)
    const later = new RelayStats({
      state: {
        current: null,
        pending: { day: '2026-11-13', regions: {}, p2p: { attempts: 0, opened: 0 } },
        sentOn: null,
      },
      save: () => {},
      now: () => now,
    })
    expect(later.due('daemon')).toBeNull()
  })
})

describe('parseRelayStatuses', () => {
  it('保留合法的区域名称并拒绝包含控制字符的名称', () => {
    expect(
      parseRelayStatuses([
        { id: 'main', url: MAIN, connection: { state: 'connected' } },
        {
          id: 'sh-1',
          url: 'https://203.0.113.7:7443',
          name: 'Shanghai',
          names: { en: 'Shanghai', 'zh-CN': '上海' },
          connection: { state: 'connected' },
        },
      ]),
    ).toEqual([
      { id: 'main', url: MAIN, connection: { state: 'connected' } },
      {
        id: 'sh-1',
        url: 'https://203.0.113.7:7443',
        name: 'Shanghai',
        names: { en: 'Shanghai', 'zh-CN': '上海' },
        connection: { state: 'connected' },
      },
    ])
    expect(
      parseRelayStatuses([
        {
          id: 'sh-1',
          url: 'https://203.0.113.7:7443',
          name: 'bad\nname',
          connection: { state: 'connected' },
        },
      ]),
    ).toBeNull()
    expect(
      parseRelayStatuses([
        {
          id: 'sh-1',
          url: 'https://203.0.113.7:7443',
          name: 'Shanghai',
          names: { bad_locale: '上海' },
          connection: { state: 'connected' },
        },
      ]),
    ).toBeNull()
  })

  it('preserves optional measured rtt and parses standby RelayRegionStatus lists', () => {
    expect(
      parseRelayStatuses([{ id: 'main', url: MAIN, connection: { state: 'connected' }, rtt: 42 }]),
    ).toEqual([{ id: 'main', url: MAIN, connection: { state: 'connected' }, rtt: 42 }])
    expect(
      parseRelayStatuses([{ id: 'main', url: MAIN, connection: { state: 'connected' }, rtt: -1 }]),
    ).toBeNull()

    const available = [
      { id: 'main', url: MAIN, connection: { state: 'connected' as const }, rtt: 180 },
      {
        id: 'gz-1',
        url: 'https://gz-1.relay.kettu.sh',
        name: 'Guangzhou',
        names: { en: 'Guangzhou', 'zh-CN': '广州' },
        connection: { state: 'standby' as const },
        rtt: 28,
      },
    ]
    expect(parseRelayRegionStatuses(available)).toEqual(available)
    expect(
      parseRelayRegionStatuses([
        {
          id: 'gz-1',
          url: 'https://gz-1.relay.kettu.sh',
          connection: { state: 'standby' },
          rtt: 'bad',
        },
      ]),
    ).toBeNull()

    const report = relayReport({
      official: true,
      ownEnabled: false,
      cloud: true,
      signedIn: true,
      relays: [{ id: 'main', url: MAIN, connection: { state: 'connected' }, rtt: 180 }],
      available,
      own: null,
      ownStatus: null,
      keyEnd: null,
    })
    expect(report).toEqual({
      state: 'on',
      relays: [{ id: 'main', url: MAIN, connection: { state: 'connected' }, rtt: 180 }],
      available,
    })
  })
})

describe('多语言区域名称解析与回退', () => {
  it('解析可选 names 字段并拒绝非法语言标签或控制字符', () => {
    const parsed = parseRegionPayload(
      {
        v: 1,
        serial: 1,
        issuedAt: 1000,
        place: { country: 'CN', asn: 4134 },
        regions: [
          {
            id: 'sh-1',
            name: 'Shanghai',
            names: { en: 'Shanghai', 'zh-CN': '上海' },
            url: 'https://203.0.113.7:7443',
            pin: v.list.regions[1]!.pin,
            state: 'active',
          },
          {
            id: 'bad-1',
            name: 'Bad',
            names: { invalid_key: '无效' },
            url: 'https://hk-1.relay.kettu.sh',
            state: 'active',
          },
        ],
        stun: [],
      },
      MAIN,
    )
    expect(parsed?.regions.map((r) => ({ id: r.id, name: r.name, names: r.names }))).toEqual([
      { id: 'sh-1', name: 'Shanghai', names: { en: 'Shanghai', 'zh-CN': '上海' } },
    ])
    expect(parseRegionNames(undefined)).toBeUndefined()
    expect(parseRegionNames({ 'zh-CN': '上海\n非法' })).toBeNull()
  })

  it('按界面语言标签匹配最合适的区域名称并在缺失时回退默认名称', () => {
    const names = { en: 'Shanghai', 'zh-CN': '上海' }
    expect(localizedRegionName('Shanghai', names, 'zh-CN')).toBe('上海')
    expect(localizedRegionName('Shanghai', names, 'zh-Hans-CN')).toBe('上海')
    expect(localizedRegionName('Shanghai', names, 'zh-TW')).toBe('上海')
    expect(localizedRegionName('Shanghai', names, 'en-US')).toBe('Shanghai')
    expect(localizedRegionName('Shanghai', names, 'ja-JP')).toBe('Shanghai')
    expect(localizedRegionName('Shanghai', undefined, 'zh-CN')).toBe('Shanghai')
  })
})
