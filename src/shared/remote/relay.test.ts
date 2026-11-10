import { describe, expect, it } from 'vitest'
import { parseKnownHost } from './hosts'
import { parseWelcome } from './protocol'
import vectors from './relay-vectors.json'
import {
  acceptSocketPath,
  base32,
  connectSocketPath,
  decodeRelayBytes,
  encodeRelayBytes,
  hostProfile,
  hostSocketPath,
  hostsPath,
  importRelayKey,
  isJoined,
  newRelaySeed,
  parseDeviceToRelay,
  parseHostToRelay,
  parseRelayHosts,
  parseRelayInfo,
  parseRelayToHost,
  relayHostId,
  relayIdBytes,
  relayInfoPath,
  relayList,
  relayRefusal,
  signInMessage,
  signInText,
  trustedRelay,
  verifyRelaySignature,
} from './relay'

const bytes = (text: string): Uint8Array => decodeRelayBytes(text)!

describe('the relay protocol', () => {
  it("derives a host's id from its Ed25519 key", async () => {
    const key = await importRelayKey(bytes(vectors.key.seed))
    expect(encodeRelayBytes(key.publicKey)).toBe(vectors.key.publicKey)
    expect(await relayHostId(key.publicKey)).toBe(vectors.key.id)
    expect(base32(relayIdBytes(vectors.key.id)!)).toBe(vectors.key.id)
  })

  it('signs the context, the origin, the id and the nonce, one per line', async () => {
    const { origin, nonce, text, signature } = vectors.signIn
    const signed = signInText(origin, vectors.key.id, nonce)
    expect(new TextDecoder().decode(signed)).toBe(text)
    const key = await importRelayKey(bytes(vectors.key.seed))
    const message = await signInMessage(key, origin, vectors.key.id, nonce, 'access-token')
    expect(message).toEqual({
      type: 'sign-in',
      publicKey: vectors.key.publicKey,
      signature,
      token: 'access-token',
    })
    expect(await verifyRelaySignature(key.publicKey, bytes(signature), signed)).toBe(true)
    const other = signInText('https://relay.example.com', vectors.key.id, nonce)
    expect(await verifyRelaySignature(key.publicKey, bytes(signature), other)).toBe(false)
  })

  it('signs with a new key that verifies', async () => {
    const key = await importRelayKey(await newRelaySeed())
    const data = new TextEncoder().encode('data')
    expect(await verifyRelaySignature(key.publicKey, await key.sign(data), data)).toBe(true)
  })

  it('names its paths', () => {
    const { id } = vectors.key
    expect(relayInfoPath()).toBe(vectors.paths.info)
    expect(hostSocketPath(id)).toBe(vectors.paths.host)
    expect(connectSocketPath(id)).toBe(vectors.paths.connect)
    expect(acceptSocketPath(id, vectors.signIn.nonce)).toBe(vectors.paths.accept)
    expect(hostsPath()).toBe('/v1/hosts')
  })

  it('maps each close code to a reason, and others to none', () => {
    for (const [code, reason] of Object.entries(vectors.closes)) {
      expect(relayRefusal(Number(code))).toBe(reason)
    }
    expect(relayRefusal(1000)).toBeNull()
    expect(relayRefusal(1006)).toBeNull()
  })

  it("reads each side's messages and refuses the rest", () => {
    for (const text of vectors.hostMessages.valid) expect(parseHostToRelay(text)).not.toBeNull()
    for (const text of vectors.hostMessages.invalid) expect(parseHostToRelay(text)).toBeNull()
    for (const text of vectors.relayMessages.valid) expect(parseRelayToHost(text)).not.toBeNull()
    for (const text of vectors.relayMessages.invalid) expect(parseRelayToHost(text)).toBeNull()
    for (const text of vectors.deviceMessages.valid) {
      expect(parseDeviceToRelay(text)).not.toBeNull()
    }
    for (const text of vectors.deviceMessages.invalid) expect(parseDeviceToRelay(text)).toBeNull()
    expect(isJoined('{"type":"joined"}')).toBe(true)
    expect(isJoined('pong')).toBe(false)
  })

  it("reads the account's hosts as a relay lists them, and nothing of a list with one wrong", () => {
    expect(parseRelayHosts(vectors.hosts.valid)).toEqual(vectors.hosts.valid.hosts)
    for (const answer of vectors.hosts.invalid) expect(parseRelayHosts(answer)).toBeNull()
  })

  it("makes a host's profile from its key, a name cut to fit and its platform", () => {
    const key = new Uint8Array(32).fill(1)
    expect(hostProfile(key, 'Studio', 'darwin')).toEqual({
      key: encodeRelayBytes(key),
      name: 'Studio',
      platform: 'darwin',
    })
    expect(hostProfile(key, ' Stu\u0007dio\n', 'linux')?.name).toBe('Studio')
    const long = hostProfile(key, `${'x'.repeat(63)}\u{1F98A}`, 'win32')!.name
    expect(long).toBe('x'.repeat(63))
    expect(hostProfile(key, '\u0001 ', 'darwin')).toBeNull()
    expect(hostProfile(key, 'Studio', 'Darwin')).toBeNull()
    expect(hostProfile(key.subarray(1), 'Studio', 'darwin')).toBeNull()
    const profile = hostProfile(key, 'x'.repeat(80), 'darwin')!
    expect(parseHostToRelay(JSON.stringify({ type: 'profile', profile }))).toEqual({
      type: 'profile',
      profile,
    })
  })

  it('lists the main relay first, then the other regions', () => {
    const info = parseRelayInfo(vectors.info.answer)!
    expect(info.features).toEqual(['hosts'])
    expect(parseRelayInfo({ ...vectors.info.answer, features: undefined })?.features).toEqual([])
    expect(
      parseRelayInfo({ ...vectors.info.answer, features: ['hosts', 7, 'x'.repeat(33)] })?.features,
    ).toEqual(['hosts'])
    expect(relayList('https://relay.kettu.sh', info.regions)).toEqual(vectors.info.list)
    expect(parseRelayInfo({ ...vectors.info.answer, protocol: 2 })).toBeNull()
    expect(relayList('http://localhost:8798', [])).toEqual([
      { id: 'main', url: 'http://localhost:8798' },
    ])
  })

  it('sends the token only to relays under the main relay domain', () => {
    const main = 'https://relay.kettu.sh'
    expect(trustedRelay('https://relay.kettu.sh', main)).toBe(true)
    expect(trustedRelay('https://hk.relay.kettu.sh', main)).toBe(true)
    expect(trustedRelay('https://relay-hk.kettu.sh', main)).toBe(true)
    expect(trustedRelay('http://relay.kettu.sh', main)).toBe(false)
    expect(trustedRelay('https://kettu.sh.example.com', main)).toBe(false)
    expect(trustedRelay('https://evilkettu.sh', main)).toBe(false)
    expect(trustedRelay('http://localhost:8798', 'http://localhost:8798')).toBe(true)
    expect(trustedRelay('http://evil.localhost:8798', 'http://localhost:8798')).toBe(false)
    expect(relayList(main, [{ id: 'x', url: 'https://example.com' }])).toEqual([
      { id: 'main', url: main },
    ])
  })
})

describe('the relay in welcomes and stored hosts', () => {
  const relay = { id: vectors.key.id, urls: ['https://relay.kettu.sh'] }
  const welcome = {
    type: 'welcome',
    protocol: 3,
    host: { name: 'Studio', platform: 'darwin', version: '0.0.26' },
    features: [],
    role: 'owner',
    device: { id: '0123456789abcdef0123456789abcdef', name: 'Laptop' },
    terminal: false,
    addresses: [],
  }

  it("reads a welcome's relay, and one from a host without it", () => {
    expect(parseWelcome({ ...welcome, relay })?.relay).toEqual(relay)
    expect(parseWelcome(welcome)?.relay).toBeUndefined()
    expect(
      parseWelcome({ ...welcome, relay: { id: 'NOT-AN-ID', urls: [] } })?.relay,
    ).toBeUndefined()
    expect(
      parseWelcome({ ...welcome, relay: { ...relay, urls: ['https://relay.kettu.sh/x', 7] } })
        ?.relay,
    ).toEqual({ ...relay, urls: [] })
  })

  it('keeps a host paired before the relay, and one that has it', () => {
    const host = {
      id: '0123456789abcdef0123456789abcdef',
      publicKey: 'AAAA',
      name: 'Studio',
      platform: 'darwin',
      version: '0.0.24',
      addresses: [{ host: '192.168.1.8', port: 47821 }],
      deviceName: 'Laptop',
      addedAt: 1,
      lastOnlineAt: null,
      removed: false,
    }
    expect(parseKnownHost(host)).toEqual(host)
    expect(parseKnownHost({ ...host, relay })).toEqual({ ...host, relay })
    expect(parseKnownHost({ ...host, relay: { id: 'x' } })).toBeNull()
  })
})
