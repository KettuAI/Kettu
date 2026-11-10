import { describe, expect, it } from 'vitest'
import {
  pairCode,
  pairCommit,
  parseDiscoveredHosts,
  parseDiscoveryEvent,
  parsePairCommit,
  parsePairConfirm,
  parsePairNonce,
  parsePairReveal,
  revealMatches,
} from './discovery'

const filled = (byte: number): Uint8Array => new Uint8Array(32).fill(byte)

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
