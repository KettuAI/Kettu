import { describe, expect, it } from 'vitest'
import { versionAtLeast } from './versions'

describe('a reader opens on the checked version or newer', () => {
  it('compares semver versions', () => {
    expect(versionAtLeast('1.5.9', '1.5.9')).toBe(true)
    expect(versionAtLeast('1.6.0', '1.5.9')).toBe(true)
    expect(versionAtLeast('1.5.10', '1.5.9')).toBe(true)
    expect(versionAtLeast('1.4.3', '1.5.9')).toBe(false)
    expect(versionAtLeast('1.5.9-beta.1', '1.5.9')).toBe(false)
  })

  it("compares other versions by their numbers in order, as Junie's", () => {
    expect(versionAtLeast('26.10.27 (3893.5)', '26.10.27 (3893.5)')).toBe(true)
    expect(versionAtLeast('26.11.13 (4020.10)', '26.10.27 (3893.5)')).toBe(true)
    expect(versionAtLeast('26.10.27 (3893.4)', '26.10.27 (3893.5)')).toBe(false)
    expect(versionAtLeast('26.9.30 (3700.1)', '26.10.27 (3893.5)')).toBe(false)
  })

  it('opens on no unknown version', () => {
    expect(versionAtLeast(null, '1.5.9')).toBe(false)
    expect(versionAtLeast(undefined, '1.5.9')).toBe(false)
    expect(versionAtLeast('', '1.5.9')).toBe(false)
    expect(versionAtLeast('dev', '1.5.9')).toBe(false)
  })
})
