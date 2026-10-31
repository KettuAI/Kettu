import { describe, expect, it } from 'vitest'
import { forbiddenToDevices } from './allow-list'
import { deviceId, normalizeDeviceName, parsePortDevice } from './device'

describe('deviceId', () => {
  it("is the hex of the first 16 bytes of the key's SHA-256", async () => {
    // SHA-256 of 32 zero bytes is 66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925.
    expect(await deviceId(new Uint8Array(32))).toBe('66687aadf862bd776c8fc18b8e9f8e20')
  })
})

describe('normalizeDeviceName', () => {
  it('keeps a name a device or the owner typed, cleaned up and cut to 64 characters', () => {
    expect(normalizeDeviceName('  My iPad\n')).toBe('My iPad')
    expect(normalizeDeviceName('Tab\there')).toBe('Tabhere')
    expect(normalizeDeviceName('狐'.repeat(70))).toBe('狐'.repeat(64))
    expect(normalizeDeviceName(`${'a'.repeat(63)}  b`)).toBe('a'.repeat(63))
  })

  it.each([null, 7, '', ' \n ', 'x'.repeat(1025)])('takes no name from %j', (value) => {
    expect(normalizeDeviceName(value)).toBeNull()
  })
})

describe('parsePortDevice', () => {
  const id = 'a'.repeat(32)

  it('reads the id and name a port names', () => {
    expect(parsePortDevice({ id, name: 'Phone', extra: true })).toEqual({ id, name: 'Phone' })
  })

  it.each([
    null,
    { id },
    { id: 'A'.repeat(32), name: 'Phone' },
    { id: 'a'.repeat(31), name: 'Phone' },
    { id, name: '' },
    { id, name: 'x'.repeat(65) },
  ])('refuses %j', (value) => {
    expect(parsePortDevice(value)).toBeNull()
  })
})

describe('forbiddenToDevices', () => {
  it('refuses what needs main and nothing else', () => {
    expect(forbiddenToDevices('media.open', {})).toBe(true)
    expect(forbiddenToDevices('projects.add', { path: '/p' })).toBe(true)
    expect(forbiddenToDevices('attachments.add', { source: { grantId: 'g' } })).toBe(true)
    expect(
      forbiddenToDevices('attachments.add', { source: { projectPath: '/p', path: 'a' } }),
    ).toBe(false)
    expect(forbiddenToDevices('attachments.add', null)).toBe(false)
    expect(forbiddenToDevices('sessions.create', {})).toBe(false)
    expect(forbiddenToDevices('projects.remove', {})).toBe(false)
  })
})
