import { describe, expect, it } from 'vitest'
import {
  groupCodeOf,
  groupPairCode,
  newPairGroup,
  pairCode,
  pairCommit,
  parsePairGroup,
  parseDiscoveredHosts,
  parseDiscoveryEvent,
  parsePairCommit,
  parsePairConfirm,
  parsePairNonce,
  parsePairReveal,
  parseReverseGrant,
  parseReverseHost,
  revealMatches,
} from './discovery'
import vectors from './pair-code-vectors.json'
import { decodeRelayBytes } from './relay'

const filled = (byte: number): Uint8Array => new Uint8Array(32).fill(byte)
const bytes = (value: string): Uint8Array => decodeRelayBytes(value)!

const NONCE = 'AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM'
const COMMIT = 'ZIqlxXn7MPOK90TZfW7IQMepEnekmaDXgPPnMU7KCQs'

describe('the code of a pairing with a host of the account', () => {
  it('hashes the context, the handshake hash and both nonces into six digits', async () => {
    // SHA-256 begins a3aca6ed: 2746001133 modulo a million, its leading zeros kept.
    expect(await pairCode(filled(1), filled(2), filled(3))).toBe('001133')
    expect(await pairCode(filled(1), filled(3), filled(2))).not.toBe('001133')
  })

  it("commits to the device's nonce with its SHA-256 and checks the reveal against it", async () => {
    expect(await pairCommit(filled(3))).toBe(COMMIT)
    expect(await revealMatches(COMMIT, filled(3))).toBe(true)
    expect(await revealMatches(COMMIT, filled(4))).toBe(false)
    expect(await revealMatches('short', filled(3))).toBe(false)
  })
})

describe('the codes in the test vectors other apps check against', () => {
  it("gives each exchange's code", async () => {
    for (const vector of vectors.single) {
      const { hash, hostNonce, deviceNonce, code } = vector
      expect(await pairCode(bytes(hash), bytes(hostNonce), bytes(deviceNonce))).toBe(code)
    }
  })

  it("gives a batch's code over its computers in order", async () => {
    for (const vector of vectors.group) {
      const parts = vector.hosts.map((host) => ({
        relayId: host.relayId,
        hash: bytes(host.hash),
        hostNonce: bytes(host.hostNonce),
        deviceNonce: bytes(host.deviceNonce),
      }))
      expect(await groupPairCode(parts)).toBe(vector.code)
      expect(await groupPairCode([...parts].reverse())).not.toBe(vector.code)
      const transcripts = new Map(vector.hosts.map((host) => [host.relayId, host]))
      const hosts = vector.hosts.map((host) => host.relayId)
      expect(await groupCodeOf(hosts, transcripts)).toBe(vector.code)
      expect(await groupCodeOf([...hosts, 'a'.repeat(26)], transcripts)).toBeNull()
    }
  })
})

describe('a batch of computers connected to with one code', () => {
  const [a, b, c] = vectors.group[1]!.hosts.map((host) => host.relayId) as [string, string, string]

  it('takes an id of 16 bytes and 2 to 16 relay ids in order, each once', () => {
    const group = newPairGroup([c, a, b, a])
    expect(group.hosts).toEqual([a, b, c])
    expect(parsePairGroup(group)).toEqual(group)
    const { id } = group
    expect(parsePairGroup({ id, hosts: [a] })).toBeNull()
    expect(parsePairGroup({ id, hosts: [b, a] })).toBeNull()
    expect(parsePairGroup({ id, hosts: [a, a] })).toBeNull()
    expect(parsePairGroup({ id, hosts: [a, 'NOT-A-RELAY-ID'] })).toBeNull()
    const many = [...'abcdefghijklmnopq'].map((letter) => `${'a'.repeat(25)}${letter}`)
    expect(parsePairGroup({ id, hosts: many.slice(0, 16) })).not.toBeNull()
    expect(parsePairGroup({ id, hosts: many })).toBeNull()
    expect(parsePairGroup({ id: id.slice(1), hosts: [a, b] })).toBeNull()
    expect(parsePairGroup({ id, hosts: [a, b], extra: true })).toBeNull()
  })

  it('rides on the commit, which refuses a malformed one', () => {
    const group = newPairGroup([a, b])
    expect(parsePairCommit({ type: 'pair-commit', commit: COMMIT, group })).toEqual({
      type: 'pair-commit',
      commit: COMMIT,
      group,
    })
    expect(
      parsePairCommit({ type: 'pair-commit', commit: COMMIT, group: { ...group, hosts: [a] } }),
    ).toBeNull()
    expect(parsePairCommit({ type: 'pair-commit', commit: COMMIT, group: null })).toBeNull()
  })
})

describe('the discovery messages', () => {
  it('reads each well-formed message', () => {
    expect(parsePairCommit({ type: 'pair-commit', commit: COMMIT })).toEqual({
      type: 'pair-commit',
      commit: COMMIT,
    })
    expect(parsePairNonce({ type: 'pair-nonce', nonce: NONCE })).not.toBeNull()
    expect(parsePairReveal({ type: 'pair-reveal', nonce: NONCE })).not.toBeNull()
    expect(parsePairConfirm({ type: 'pair-confirm' })).toEqual({ type: 'pair-confirm' })
  })

  it('refuses other types, other lengths, padding and fields of more', () => {
    expect(parsePairCommit({ type: 'pair-reveal', commit: COMMIT })).toBeNull()
    expect(parsePairCommit({ type: 'pair-commit', commit: NONCE.slice(0, 40) })).toBeNull()
    expect(parsePairCommit({ type: 'pair-commit', commit: `${COMMIT}=` })).toBeNull()
    expect(parsePairCommit({ type: 'pair-commit', commit: `${COMMIT}AA` })).toBeNull()
    expect(parsePairCommit({ type: 'pair-commit', commit: COMMIT, extra: 1 })).toBeNull()
    expect(parsePairNonce({ type: 'pair-nonce', nonce: 7 })).toBeNull()
    expect(parsePairReveal({ type: 'pair-reveal' })).toBeNull()
    expect(parsePairReveal([{ type: 'pair-reveal', nonce: NONCE }])).toBeNull()
    expect(parsePairConfirm({ type: 'pair-confirm', code: '123456' })).toBeNull()
    expect(parsePairConfirm(null)).toBeNull()
  })

  it("checks a request's events and the listed hosts where they cross a process", () => {
    const confirm = {
      requestId: 1,
      request: {
        state: 'confirm',
        device: { name: 'Laptop', model: 'MacBook Air', kind: 'desktop', platform: 'macOS 26' },
        code: '001133',
        startedAt: 1,
        expiresAt: 2,
        deviceConfirmed: false,
        transcript: { hash: NONCE, hostNonce: NONCE, deviceNonce: COMMIT },
      },
    }
    expect(parseDiscoveryEvent({ ...confirm, request: { ...confirm.request } })).toBeNull()
    const known = {
      ...confirm,
      request: { ...confirm.request, device: { ...confirm.request.device, known: false } },
    }
    expect(parseDiscoveryEvent(known)).toEqual(known)
    expect(
      parseDiscoveryEvent({ ...known, request: { ...known.request, code: '1133' } }),
    ).toBeNull()
    expect(
      parseDiscoveryEvent({ requestId: 2, request: { state: 'closed', reason: 'added' } }),
    ).not.toBeNull()
    expect(
      parseDiscoveryEvent({ requestId: 2, request: { state: 'closed', reason: 'gone' } }),
    ).toBeNull()

    const host = {
      relayId: 'eh7ddx5bksrgcytl7bkai36se4',
      publicKey: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',
      name: 'Studio',
      platform: 'darwin',
    }
    expect(parseDiscoveredHosts({ state: 'ok', hosts: [host] })).toEqual({
      state: 'ok',
      hosts: [host],
    })
    expect(parseDiscoveredHosts({ state: 'signed_out' })).toEqual({ state: 'signed_out' })
    expect(parseDiscoveredHosts({ state: 'ok', hosts: [{ ...host, relayId: 'x' }] })).toBeNull()
  })
})

describe('the reverse grant', () => {
  const host = {
    relayId: 'eh7ddx5bksrgcytl7bkai36se4',
    publicKey: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',
    name: 'Studio',
    platform: 'darwin',
    relays: ['https://relay.example.test'],
    version: '0.2.0',
  }

  it("takes the calling computer's own host only as a whole, reachable through its relay", () => {
    expect(parseReverseHost(host)).toEqual(host)
    expect(parseReverseHost({ ...host, extra: 1 })).toBeNull()
    expect(parseReverseHost({ ...host, relayId: 'x' })).toBeNull()
    expect(parseReverseHost({ ...host, publicKey: host.publicKey.slice(1) })).toBeNull()
    expect(parseReverseHost({ ...host, name: ' Studio' })).toBeNull()
    expect(parseReverseHost({ ...host, platform: 'Mac OS' })).toBeNull()
    expect(parseReverseHost({ ...host, relays: [] })).toBeNull()
    expect(parseReverseHost({ ...host, relays: ['https://relay.example.test/path'] })).toBeNull()
    expect(parseReverseHost({ ...host, relays: ['javascript:alert(1)'] })).toBeNull()
    expect(parseReverseHost({ ...host, version: undefined })).toBeNull()
  })

  it("keeps the pin of the owner's own relay only as a pairing code would carry it", () => {
    const pin = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc'
    const pinned = { ...host, relays: ['https://203.0.113.7:8443'], pin }
    expect(parseReverseHost(pinned)).toEqual(pinned)
    expect(parseReverseHost({ ...pinned, pin: pin.slice(4) })).toBeNull()
    expect(parseReverseHost({ ...pinned, pin: 7 })).toBeNull()
    expect(parseReverseHost({ ...pinned, relays: ['http://203.0.113.7:8443'] })).toBeNull()
  })

  it("takes the answering computer's device key, name and platform, and nothing else", () => {
    const grant = { deviceKey: host.publicKey, name: 'Laptop', platform: 'macOS 26' }
    expect(parseReverseGrant(grant)).toEqual(grant)
    expect(parseReverseGrant('unsupported')).toBeNull()
    expect(parseReverseGrant({ ...grant, deviceKey: 'AQ==' })).toBeNull()
    expect(parseReverseGrant({ ...grant, name: '' })).toBeNull()
    expect(parseReverseGrant({ ...grant, account: 'a' })).toBeNull()
  })
})
