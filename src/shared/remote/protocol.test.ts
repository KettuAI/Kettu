import { describe, expect, it } from 'vitest'
import { parseClosing, parseHello, parseWelcome } from './protocol'

const HELLO = {
  type: 'hello',
  protocol: { min: 1, max: 4 },
  client: { kind: 'ios', version: '1.0.0', platform: 'iOS 26.1' },
}

const WELCOME = {
  type: 'welcome',
  protocol: 4,
  host: { name: 'Studio', platform: 'darwin', version: '1.0.0' },
  features: [],
  role: 'owner',
  device: { id: '0123456789abcdef0123456789abcdef', name: 'Phone' },
  terminal: false,
  addresses: [],
}

describe("a hello's account", () => {
  it('is kept when it is one, and absent when the device is signed in to none', () => {
    expect(parseHello({ ...HELLO, account: 'acc_01J9' })?.account).toBe('acc_01J9')
    expect(parseHello(HELLO)).not.toHaveProperty('account')
  })

  it('makes the hello invalid when it is not one', () => {
    for (const account of ['', 'x'.repeat(129), 'a\nb', 'a\u0000b', 42, null, {}]) {
      expect(parseHello({ ...HELLO, account })).toBeNull()
    }
    expect(parseHello({ ...HELLO, account: 'x'.repeat(128) })?.account).toHaveLength(128)
  })
})

describe("a welcome's account", () => {
  it("is the host's, and reads as none when it is not one", () => {
    expect(parseWelcome({ ...WELCOME, account: 'acc_01J9' })?.account).toBe('acc_01J9')
    expect(parseWelcome(WELCOME)).not.toHaveProperty('account')
    expect(parseWelcome({ ...WELCOME, account: 'a\u0007b' })).not.toHaveProperty('account')
  })
})

describe('the closing for another account', () => {
  it('is one a device reads', () => {
    expect(parseClosing({ type: 'closing', reason: 'other_account' })).toEqual({
      type: 'closing',
      reason: 'other_account',
    })
  })
})
