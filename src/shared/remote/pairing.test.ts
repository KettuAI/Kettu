import { describe, expect, it } from 'vitest'
import {
  browserPairingLink,
  decodePairing,
  encodePairing,
  hostedPairingLink,
  MAX_PAIRING_ADDRESSES,
  pairingLink,
  parseBrowserPairingLink,
  parsePairingLink,
  DIRECT_PAIRING_VERSION,
  ownRelayPairingLink,
  PAIRING_VERSION,
  PINNED_PAIRING_VERSION,
  type PairingPayload,
} from './pairing'
import vectors from './relay-vectors.json'

const hex = (text: string): Uint8Array =>
  Uint8Array.from(text.match(/../g)!, (byte) => parseInt(byte, 16))

const payload: PairingPayload = {
  version: DIRECT_PAIRING_VERSION,
  hostKey: Uint8Array.from({ length: 32 }, (_, i) => i),
  secret: Uint8Array.from({ length: 32 }, (_, i) => 255 - i),
  addresses: [
    { host: '192.168.1.8', port: 47821 },
    { host: 'fd3c:9a1e:5b20::8', port: 47821 },
    { host: 'frp.example.com', port: 60021 },
  ],
}

describe('pairing codes', () => {
  it('carry the version, key, secret and addresses in the fragment, in base64url', () => {
    const link = pairingLink(payload)
    expect(link.startsWith('https://kettu.sh/pair#')).toBe(true)
    const fragment = link.slice(link.indexOf('#') + 1)
    expect(fragment).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(parsePairingLink(link)).toEqual(payload)
  })

  it('takes a code without addresses', () => {
    const bare = { ...payload, addresses: [] }
    const text = encodePairing(bare)
    // The version, the key and the secret: 65 bytes.
    expect(text).toHaveLength(87)
    expect(decodePairing(text)).toEqual(bare)
  })

  it('carries at most 16 addresses', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ host: `10.0.0.${i}`, port: 1000 + i }))
    const decoded = decodePairing(encodePairing({ ...payload, addresses: many }))!
    expect(decoded.addresses).toEqual(many.slice(0, MAX_PAIRING_ADDRESSES))
  })

  it('refuses what is not a code of this version', () => {
    const text = encodePairing(payload)
    const bytes = Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
      c.charCodeAt(0),
    )
    const encode = (b: Uint8Array) =>
      btoa(String.fromCharCode(...b))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
    expect(decodePairing(encode(Uint8Array.of(4, ...bytes.subarray(1))))).toBeNull()
    expect(decodePairing(encode(bytes.subarray(0, 64)))).toBeNull()
    expect(decodePairing(encode(bytes.subarray(0, bytes.length - 1)))).toBeNull()
    expect(decodePairing('not base64!')).toBeNull()
    expect(parsePairingLink(`https://example.com/pair#${text}`)).toBeNull()
    expect(parsePairingLink('https://kettu.sh/pair')).toBeNull()
  })

  it('make a code without the relay as version 1, which devices that know only it read', () => {
    const text = encodePairing({ ...payload, version: PAIRING_VERSION })
    expect(atob(text.slice(0, 2) + '==').charCodeAt(0)).toBe(1)
    expect(decodePairing(text)).toEqual(payload)
  })

  it('carry the relay id and the relays from version 2, before the addresses', () => {
    const relayed: PairingPayload = {
      ...payload,
      version: PAIRING_VERSION,
      relay: {
        id: 'aeiscmkbkfqxdamrugy4dupb6e',
        urls: ['https://relay.kettu.sh', 'https://hk.relay.kettu.sh'],
      },
    }
    const text = encodePairing(relayed)
    expect(decodePairing(text)).toEqual(relayed)
    expect(decodePairing(encodePairing({ ...relayed, addresses: [] }))).toEqual({
      ...relayed,
      addresses: [],
    })
    // The version, the key, the secret, the id, the count and both origins.
    const bare = encodePairing({ ...relayed, addresses: [] })
    expect(bare.length).toBe(Math.ceil(((65 + 16 + 1 + 23 + 26) * 4) / 3))
  })

  it('refuse a relay part that is cut short or names no origin', () => {
    const relayed = encodePairing({
      ...payload,
      version: PAIRING_VERSION,
      addresses: [],
      relay: { id: 'aeiscmkbkfqxdamrugy4dupb6e', urls: ['https://relay.kettu.sh'] },
    })
    const bytes = Uint8Array.from(atob(relayed.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
      c.charCodeAt(0),
    )
    const encode = (b: Uint8Array) =>
      btoa(String.fromCharCode(...b))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
    expect(decodePairing(encode(bytes.subarray(0, bytes.length - 3)))).toBeNull()
    const path = Uint8Array.from(bytes)
    path.set(new TextEncoder().encode('https://relay.kettu.s/'), 65 + 16 + 2)
    expect(decodePairing(encode(path))).toBeNull()
    expect(() =>
      encodePairing({
        ...payload,
        relay: { id: 'aeiscmkbkfqxdamrugy4dupb6e', urls: ['https://relay.kettu.sh/v1'] },
      }),
    ).toThrow()
    expect(() => encodePairing({ ...payload, relay: { id: 'NOT-AN-ID', urls: [] } })).toThrow()
  })

  it('carry a pinned relay as version 3, its pin after the relays', () => {
    const vector = vectors.ownRelay.pairing
    const pinned: PairingPayload = {
      version: PINNED_PAIRING_VERSION,
      hostKey: hex(vector.hostKey),
      secret: hex(vector.secret),
      relay: vector.relay,
      addresses: vector.addresses,
    }
    expect(encodePairing(pinned)).toBe(vector.text)
    expect(decodePairing(vector.text)).toEqual(pinned)
    // Without a pin the code stays version 2, which devices before the own relay read.
    const plain = encodePairing({
      ...pinned,
      relay: { id: vector.relay.id, urls: vector.relay.urls },
    })
    expect(atob(plain.slice(0, 2) + '==').charCodeAt(0)).toBe(PAIRING_VERSION)
    // A pin is cut short, or pins a relay a browser or a device reaches over plain http.
    expect(decodePairing(vector.text.slice(0, 160))).toBeNull()
    expect(() =>
      encodePairing({ ...pinned, relay: { ...vector.relay, urls: ['http://127.0.0.1:8798'] } }),
    ).toThrow()
    expect(() => encodePairing({ ...pinned, relay: { ...vector.relay, pin: 'AAAA' } })).toThrow()
  })

  it('give a browser the own relay’s web client, unless the relay is pinned', () => {
    const vector = vectors.ownRelay.pairing
    const code: PairingPayload = {
      version: PAIRING_VERSION,
      hostKey: hex(vector.hostKey),
      secret: hex(vector.secret),
      relay: { id: vector.relay.id, urls: ['https://relay.example.com'] },
      addresses: [],
    }
    const link = ownRelayPairingLink(code, 'https://relay.example.com')
    expect(link?.startsWith('https://relay.example.com/pair#')).toBe(true)
    expect(parseBrowserPairingLink(link!)).toEqual(code)
    expect(
      ownRelayPairingLink({ ...code, relay: vector.relay }, 'https://203.0.113.7:7443'),
    ).toBeNull()
  })

  it('refuses to carry a host that is not one', () => {
    expect(() =>
      encodePairing({ ...payload, addresses: [{ host: 'https://x', port: 1 }] }),
    ).toThrow()
    expect(() => encodePairing({ ...payload, addresses: [{ host: 'x', port: 0 }] })).toThrow()
  })
})

describe('browser pairing links', () => {
  it('open the web client at a host address, the code in the fragment', () => {
    const link = browserPairingLink({ host: '192.168.1.8', port: 47821 }, payload)!
    expect(link.startsWith('http://192.168.1.8:47821/pair#')).toBe(true)
    expect(parseBrowserPairingLink(link)).toEqual(payload)
  })

  it('put an IPv6 address in brackets and leave out one with a zone', () => {
    const link = browserPairingLink({ host: 'fd3c:9a1e:5b20::8', port: 47821 }, payload)!
    expect(new URL(link).host).toBe('[fd3c:9a1e:5b20::8]:47821')
    expect(parseBrowserPairingLink(link)).toEqual(payload)
    expect(browserPairingLink({ host: 'fe80::1%en0', port: 47821 }, payload)).toBeNull()
  })

  it("take the app's link and a link through another address or https", () => {
    expect(parseBrowserPairingLink(`  ${pairingLink(payload)} `)).toEqual(payload)
    const code = encodePairing(payload)
    expect(parseBrowserPairingLink(`http://localhost:47821/pair#${code}`)).toEqual(payload)
    expect(parseBrowserPairingLink(`https://mac.tail1.ts.net/pair#${code}`)).toEqual(payload)
  })

  it('open the hosted web client only for a code with the relay', () => {
    expect(hostedPairingLink(payload)).toBeNull()
    const relayed: PairingPayload = {
      ...payload,
      version: PAIRING_VERSION,
      relay: { id: 'aeiscmkbkfqxdamrugy4dupb6e', urls: ['https://relay.kettu.sh'] },
    }
    const link = hostedPairingLink(relayed)!
    expect(link.startsWith('https://app.kettu.sh/pair#')).toBe(true)
    expect(parseBrowserPairingLink(link)).toEqual(relayed)
  })

  it('refuse other pages, schemes and broken codes', () => {
    const code = encodePairing(payload)
    expect(parseBrowserPairingLink(`http://localhost:47821/#${code}`)).toBeNull()
    expect(parseBrowserPairingLink(`ftp://localhost/pair#${code}`)).toBeNull()
    expect(parseBrowserPairingLink('http://localhost:47821/pair#')).toBeNull()
    expect(parseBrowserPairingLink('http://localhost:47821/pair#abc')).toBeNull()
    expect(parseBrowserPairingLink('not a link')).toBeNull()
  })
})
