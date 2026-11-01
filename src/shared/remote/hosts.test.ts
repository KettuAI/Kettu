import { describe, expect, it } from 'vitest'
import { parseHostPairingState, parseKnownHost, parseSshTarget, type KnownHost } from './hosts'

const HOST: KnownHost = {
  id: 'a'.repeat(32),
  publicKey: 'a2V5',
  name: 'dev-box',
  platform: 'linux',
  version: '0.3.0',
  addresses: [],
  deviceName: 'Lin MacBook',
  addedAt: 1,
  lastOnlineAt: null,
  removed: false,
}

describe('parseSshTarget', () => {
  it.each([
    ['lin@dev-box', 'lin@dev-box'],
    ['  dev-box  ', 'dev-box'],
    ['ssh://lin@dev-box:2222', 'ssh://lin@dev-box:2222'],
    ['lin@[fd00::1]', 'lin@[fd00::1]'],
  ])('takes %j', (typed, target) => {
    expect(parseSshTarget(typed)).toBe(target)
  })

  // ssh would read the first as an option; the rest are not one address.
  it.each(['-oProxyCommand=sh', 'lin@dev box', 'dev\nbox', 'a\u0000b', '', '   ', 'x'.repeat(256)])(
    'refuses %j',
    (typed) => {
      expect(parseSshTarget(typed)).toBeNull()
    },
  )

  it('refuses what is no text', () => {
    expect(parseSshTarget(42)).toBeNull()
  })
})

describe('a host added over SSH', () => {
  it('keeps its route, and a host kept before routes had one is direct', () => {
    const ssh = { target: 'lin@dev-box', port: 52001 }
    expect(parseKnownHost({ ...HOST, ssh })).toEqual({ ...HOST, ssh })
    expect(parseKnownHost(HOST)).toEqual(HOST)
    expect(parseKnownHost({ ...HOST, ssh: { target: '-x', port: 52001 } })).toBeNull()
    expect(parseKnownHost({ ...HOST, ssh: { target: 'dev-box', port: 0 } })).toBeNull()
    expect(parseKnownHost({ ...HOST, ssh: null })).toBeNull()
  })

  it("reads each step of adding it, and a failure's detail", () => {
    expect(parseHostPairingState({ state: 'ssh', step: 'connecting' })).toEqual({
      state: 'ssh',
      step: 'connecting',
    })
    expect(
      parseHostPairingState({ state: 'ssh', step: 'updating', from: '0.2.0', to: '0.3.0', x: 1 }),
    ).toEqual({ state: 'ssh', step: 'updating', from: '0.2.0', to: '0.3.0' })
    expect(parseHostPairingState({ state: 'ssh', step: 'installing' })).toBeNull()
    expect(parseHostPairingState({ state: 'ssh', step: 'dancing' })).toBeNull()
    expect(
      parseHostPairingState({ state: 'failed', reason: 'ssh_install', detail: 'x'.repeat(5000) }),
    ).toEqual({ state: 'failed', reason: 'ssh_install', detail: 'x'.repeat(4096) })
    expect(parseHostPairingState({ state: 'failed', reason: 'ssh_auth', detail: '' })).toEqual({
      state: 'failed',
      reason: 'ssh_auth',
    })
    expect(parseHostPairingState({ state: 'failed', reason: 'ssh_nope' })).toBeNull()
  })
})
