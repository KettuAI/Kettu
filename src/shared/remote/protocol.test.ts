import { describe, expect, it } from 'vitest'
import { negotiate, parseClosing, parseHello, parseWelcome } from './protocol'

const hello = {
  type: 'hello',
  protocol: { min: 1, max: 2 },
  client: { kind: 'ios', version: '1.2.0', platform: 'ios' },
}

describe('negotiate', () => {
  it('picks the newest version both sides speak', () => {
    expect(negotiate({ min: 1, max: 1 }, { min: 1, max: 1 })).toBe(1)
    expect(negotiate({ min: 1, max: 5 }, { min: 2, max: 3 })).toBe(3)
    expect(negotiate({ min: 3, max: 4 }, { min: 1, max: 3 })).toBe(3)
  })

  it('says which side to update when they share none', () => {
    expect(negotiate({ min: 1, max: 1 }, { min: 2, max: 3 })).toBe('update_client')
    expect(negotiate({ min: 4, max: 5 }, { min: 2, max: 3 })).toBe('update_host')
  })
})

describe('parseHello', () => {
  it('reads a hello and leaves out what it does not know', () => {
    expect(parseHello({ ...hello, resume: 'token' })).toEqual(hello)
  })

  it("reads a pairing device's name, cleaned up, and its model", () => {
    expect(
      parseHello({ ...hello, device: { name: ' Lin\u0007 iPad ', model: 'iPad Air' } }),
    ).toEqual({ ...hello, device: { name: 'Lin iPad', model: 'iPad Air' } })
    expect(parseHello({ ...hello, device: { name: '  ', model: 'iPad Air' } })).toEqual(hello)
    expect(parseHello({ ...hello, device: { name: 'iPad', model: 7 } })).toEqual(hello)
  })

  it.each([
    null,
    'hello',
    { ...hello, type: 'welcome' },
    { ...hello, protocol: { min: 2, max: 1 } },
    { ...hello, protocol: { min: 0, max: 1 } },
    { ...hello, protocol: { min: 1.5, max: 2 } },
    { ...hello, protocol: null },
    { ...hello, client: { kind: 'ios', version: '1.2.0' } },
    { ...hello, client: { kind: '', version: '1.2.0', platform: 'ios' } },
    { ...hello, client: { kind: 'ios', version: 'x'.repeat(65), platform: 'ios' } },
  ])('refuses %j', (value) => {
    expect(parseHello(value)).toBeNull()
  })
})

const welcome = {
  type: 'welcome',
  protocol: 1,
  host: { name: 'Studio', platform: 'linux', version: '0.2.0' },
  features: [],
  role: 'owner',
  device: { id: 'a'.repeat(32), name: 'Lin MacBook' },
  terminal: false,
  addresses: [{ host: '192.168.1.8', port: 47821 }],
}

describe('parseWelcome', () => {
  it('reads a welcome, dropping the addresses that are none', () => {
    expect(parseWelcome(welcome)).toEqual(welcome)
    expect(
      parseWelcome({
        ...welcome,
        addresses: [{ host: 'a b', port: 1 }, ...welcome.addresses, 'x'],
        resume: 'token',
      }),
    ).toEqual(welcome)
  })

  it.each([
    null,
    { ...welcome, type: 'hello' },
    { ...welcome, protocol: 2 },
    { ...welcome, host: { name: '', platform: 'linux', version: '0.2.0' } },
    { ...welcome, host: null },
    { ...welcome, device: { id: 'x', name: 'Lin MacBook' } },
    { ...welcome, device: { id: 'a'.repeat(32), name: ' ' } },
  ])('refuses %j', (value) => {
    expect(parseWelcome(value)).toBeNull()
  })
})

describe('parseClosing', () => {
  it('reads the reasons it knows', () => {
    expect(parseClosing({ type: 'closing', reason: 'removed' })).toEqual({
      type: 'closing',
      reason: 'removed',
    })
    expect(parseClosing({ type: 'closing', reason: 'later' })).toBeNull()
  })
})
