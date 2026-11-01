import { describe, expect, it } from 'vitest'
import {
  browserPairingLink,
  decodePairing,
  encodePairing,
  MAX_PAIRING_ADDRESSES,
  pairingLink,
  parseBrowserPairingLink,
  parsePairingLink,
  PAIRING_VERSION,
  type PairingPayload,
} from './pairing'

const payload: PairingPayload = {
  version: PAIRING_VERSION,
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
    expect(decodePairing(encode(Uint8Array.of(2, ...bytes.subarray(1))))).toBeNull()
    expect(decodePairing(encode(bytes.subarray(0, 64)))).toBeNull()
    expect(decodePairing(encode(bytes.subarray(0, bytes.length - 1)))).toBeNull()
    expect(decodePairing('not base64!')).toBeNull()
    expect(parsePairingLink(`https://example.com/pair#${text}`)).toBeNull()
    expect(parsePairingLink('https://kettu.sh/pair')).toBeNull()
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

  it('refuse other pages, schemes and broken codes', () => {
    const code = encodePairing(payload)
    expect(parseBrowserPairingLink(`http://localhost:47821/#${code}`)).toBeNull()
    expect(parseBrowserPairingLink(`ftp://localhost/pair#${code}`)).toBeNull()
    expect(parseBrowserPairingLink('http://localhost:47821/pair#')).toBeNull()
    expect(parseBrowserPairingLink('http://localhost:47821/pair#abc')).toBeNull()
    expect(parseBrowserPairingLink('not a link')).toBeNull()
  })
})
