import { describe, expect, it } from 'vitest'
import { addressArgs } from './ssh'

describe('addressArgs', () => {
  it('ends with the target after --, so no address reads as an option', () => {
    expect(addressArgs({ target: 'dev-box' })).toEqual(['--', 'dev-box'])
  })

  it('passes the port and the key file alone, with IdentitiesOnly, before the target', () => {
    expect(
      addressArgs({ target: 'lin@10.0.0.12', sshPort: 2222, identityFile: '/k/my key' }),
    ).toEqual(['-p', '2222', '-i', '/k/my key', '-o', 'IdentitiesOnly=yes', '--', 'lin@10.0.0.12'])
  })
})
