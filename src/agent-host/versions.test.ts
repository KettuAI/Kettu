import { describe, expect, it } from 'vitest'
import { compareVersions, highestVersion, isVersion } from './versions'

describe('compareVersions', () => {
  const sorted = (versions: string[]): string[] => versions.toSorted(compareVersions)

  it('orders by number, not by text', () => {
    expect(compareVersions('0.160.10', '0.160.9')).toBeGreaterThan(0)
    expect(compareVersions('2.2.2', '2.10.0')).toBeLessThan(0)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('1.0.0+build.2', '1.0.0+build.1')).toBe(0)
  })

  it('puts prereleases below their release, by semver precedence', () => {
    expect(
      sorted([
        '1.0.0',
        '1.0.0-rc.1',
        '1.0.0-beta.11',
        '1.0.0-beta.2',
        '1.0.0-beta',
        '1.0.0-alpha.beta',
        '1.0.0-alpha.1',
        '1.0.0-alpha',
      ]),
    ).toEqual([
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
    ])
    expect(compareVersions('0.94.1-preview.5', '0.94.0')).toBeGreaterThan(0)
  })

  it('counts text that is no version as older than any version', () => {
    expect(compareVersions('latest', '0.0.1')).toBeLessThan(0)
    expect(compareVersions('0.0.1', 'v1')).toBeGreaterThan(0)
    expect(compareVersions('junk', 'other')).toBe(0)
  })
})

describe('isVersion', () => {
  it('takes plain versions only', () => {
    expect(isVersion('2.1.303')).toBe(true)
    expect(isVersion('2.2.3-preview.24')).toBe(true)
    for (const text of ['v1.0.0', '1.0', '01.0.0', '1.0.0 && calc', '1.0.0-%PATH%', '', 1]) {
      expect(isVersion(text)).toBe(false)
    }
  })
})

describe('highestVersion', () => {
  it('reads what npm view prints for one version or several', () => {
    expect(highestVersion('2.1.303')).toBe('2.1.303')
    expect(highestVersion(['2.1.300', '2.1.308', '2.1.304'])).toBe('2.1.308')
    expect(highestVersion(['nope', '0.160.2', 3])).toBe('0.160.2')
    expect(highestVersion(undefined)).toBeNull()
    expect(highestVersion({ version: '1.0.0' })).toBeNull()
  })
})
