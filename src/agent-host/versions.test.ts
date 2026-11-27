import { describe, expect, it } from 'vitest'
import { parseCliVersion } from './installed-cli'
import { compareVersions, isVersion, normalizeVersion, versionAtLeast } from './versions'

describe('semantic version parsing and comparison', () => {
  it('keeps isVersion strict while normalizeVersion trims whitespace and a leading v/V', () => {
    expect(isVersion('1.5.18')).toBe(true)
    expect(isVersion('1.5.18-beta.1+build.42')).toBe(true)
    expect(isVersion('v1.5.18')).toBe(false)
    expect(isVersion(' 1.5.18 ')).toBe(false)
    expect(isVersion('')).toBe(false)
    expect(isVersion(null)).toBe(false)

    expect(normalizeVersion('1.5.18')).toBe('1.5.18')
    expect(normalizeVersion('v1.5.18')).toBe('1.5.18')
    expect(normalizeVersion('  V1.5.18-rc.2+sha.abc  ')).toBe('1.5.18-rc.2+sha.abc')
    expect(normalizeVersion('')).toBeNull()
    expect(normalizeVersion('   ')).toBeNull()
    expect(normalizeVersion('latest')).toBeNull()
    expect(normalizeVersion('vv1.5.18')).toBeNull()
    expect(normalizeVersion(null)).toBeNull()
    expect(normalizeVersion(undefined)).toBeNull()
  })

  it('compares semver versions across prefixes, prereleases, build metadata, and non-versions', () => {
    expect(compareVersions('1.5.18', '1.5.18')).toBe(0)
    expect(compareVersions('v1.5.18', '1.5.18')).toBe(0)
    expect(compareVersions('1.5.18', 'V1.5.18')).toBe(0)
    expect(compareVersions('1.5.18+build.1', '1.5.18+build.2')).toBe(0)
    expect(compareVersions('1.5.18+build.1', '1.5.18')).toBe(0)
    expect(compareVersions('1.5.18-beta.1', '1.5.18')).toBeLessThan(0)
    expect(compareVersions('1.5.18-beta.2', '1.5.18-beta.10')).toBeLessThan(0)
    expect(compareVersions('1.5.18-1', '1.5.18-alpha')).toBeLessThan(0)
    expect(compareVersions('1.5.19', '1.5.18')).toBeGreaterThan(0)
    expect(compareVersions('1.5.18', '')).toBeGreaterThan(0)
    expect(compareVersions('', '1.5.18')).toBeLessThan(0)
    expect(compareVersions('', '')).toBe(0)
  })

  it('extracts CLI versions with optional v/V prefixes, prereleases, and build metadata', () => {
    expect(parseCliVersion('1.5.18\n')).toBe('1.5.18')
    expect(parseCliVersion('v1.5.18')).toBe('1.5.18')
    expect(parseCliVersion('V19.2.1')).toBe('19.2.1')
    expect(parseCliVersion('2.1.332 (Claude Code)')).toBe('2.1.332')
    expect(parseCliVersion('codex-cli 0.172.0')).toBe('0.172.0')
    expect(parseCliVersion('tool 1.2.3-rc.1.')).toBe('1.2.3-rc.1')
    expect(parseCliVersion('cortex 1.0.73+180523.e6179a031de9')).toBe('1.0.73+180523.e6179a031de9')
    expect(parseCliVersion('')).toBeNull()
    expect(parseCliVersion('no version here')).toBeNull()
  })
})

describe('a reader opens on the checked version or newer', () => {
  it('compares semver versions', () => {
    expect(versionAtLeast('1.5.9', '1.5.9')).toBe(true)
    expect(versionAtLeast('v1.5.9', '1.5.9')).toBe(true)
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
