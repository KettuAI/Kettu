import { describe, expect, it } from 'vitest'
import {
  parseIdentityFile,
  parseKnownHost,
  parseSshAddress,
  parseSshPort,
  sameSshAddress,
  type KnownHost,
} from './hosts'

describe('parseSshPort', () => {
  it('takes a whole number from 1 to 65535', () => {
    expect(parseSshPort(22)).toBe(22)
    expect(parseSshPort(65535)).toBe(65535)
    for (const port of [0, 65536, 22.5, -1, '22', null, Number.NaN]) {
      expect(parseSshPort(port)).toBeNull()
    }
  })
})

describe('parseIdentityFile', () => {
  it('takes an absolute path on POSIX or Windows', () => {
    expect(parseIdentityFile('/Users/lin/.ssh/id_ed25519')).toBe('/Users/lin/.ssh/id_ed25519')
    expect(parseIdentityFile('/home/lin/keys/my key')).toBe('/home/lin/keys/my key')
    expect(parseIdentityFile('C:\\Users\\lin\\.ssh\\id_rsa')).toBe('C:\\Users\\lin\\.ssh\\id_rsa')
    expect(parseIdentityFile('c:/keys/id')).toBe('c:/keys/id')
    expect(parseIdentityFile('\\\\server\\share\\id')).toBe('\\\\server\\share\\id')
  })

  it('refuses relative paths, options, control characters and long paths', () => {
    for (const file of [
      '',
      'id_rsa',
      '~/.ssh/id_rsa',
      '-oProxyCommand=x',
      'C:id_rsa',
      '/keys/id\nHost *',
      '/keys/\u0000id',
      `/${'a'.repeat(1024)}`,
      42,
      null,
    ]) {
      expect(parseIdentityFile(file)).toBeNull()
    }
    expect(parseIdentityFile(`/${'a'.repeat(1023)}`)).not.toBeNull()
  })
})

describe('parseSshAddress', () => {
  it('takes a target with each option absent or valid', () => {
    expect(parseSshAddress({ target: ' lin@dev-box ' })).toEqual({ target: 'lin@dev-box' })
    expect(
      parseSshAddress({ target: 'lin@10.0.0.12', sshPort: 2222, identityFile: '/k/id' }),
    ).toEqual({ target: 'lin@10.0.0.12', sshPort: 2222, identityFile: '/k/id' })
  })

  it('refuses a bad target or a bad option', () => {
    for (const value of [
      null,
      'lin@dev-box',
      { target: '-oProxyCommand=x' },
      { target: 'dev box' },
      { target: 'dev', sshPort: 0 },
      { target: 'dev', sshPort: '22' },
      { target: 'dev', sshPort: null },
      { target: 'dev', identityFile: 'id_rsa' },
      { target: 'dev', identityFile: null },
    ]) {
      expect(parseSshAddress(value)).toBeNull()
    }
  })
})

describe('sameSshAddress', () => {
  it('matches the target and the port, whichever key file logs in', () => {
    expect(sameSshAddress({ target: 'dev' }, { target: 'dev', identityFile: '/k/id' })).toBe(true)
    expect(sameSshAddress({ target: 'dev' }, { target: 'dev', sshPort: 2222 })).toBe(false)
    expect(sameSshAddress({ target: 'dev' }, { target: 'lab' })).toBe(false)
  })
})

describe('parseKnownHost with an SSH route', () => {
  const host: KnownHost = {
    id: '0123456789abcdef0123456789abcdef',
    publicKey: 'AAAA',
    name: 'Dev box',
    platform: 'linux',
    version: '0.1.10',
    addresses: [],
    deviceName: 'Mac',
    addedAt: 1,
    lastOnlineAt: null,
    removed: false,
  }

  it('keeps the port and the key file a machine typed by hand was added with', () => {
    const ssh = { target: 'lin@10.0.0.12', port: 47821, sshPort: 2222, identityFile: '/k/id' }
    expect(parseKnownHost({ ...host, ssh })).toEqual({ ...host, ssh })
    expect(parseKnownHost({ ...host, ssh: { target: 'dev', port: 47821 } })).toEqual({
      ...host,
      ssh: { target: 'dev', port: 47821 },
    })
  })

  it('refuses a route with a bad port, key file or untrimmed target', () => {
    for (const ssh of [
      { target: 'dev', port: 47821, sshPort: 70000 },
      { target: 'dev', port: 47821, identityFile: 'relative' },
      { target: ' dev', port: 47821 },
      { target: 'dev', port: 0 },
    ]) {
      expect(parseKnownHost({ ...host, ssh })).toBeNull()
    }
  })
})
