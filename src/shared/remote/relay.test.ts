import { describe, expect, it } from 'vitest'
import vectors from './relay-vectors.json'
import {
  acceptSocketPath,
  base32,
  connectSocketPath,
  decodeRelayBytes,
  encodeRelayBytes,
  hostSocketPath,
  importRelayKey,
  isJoined,
  newRelaySeed,
  parseDeviceToRelay,
  parseHostToRelay,
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

  it('lists the main relay first, then the other regions', () => {
    const info = parseRelayInfo(vectors.info.answer)!
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
