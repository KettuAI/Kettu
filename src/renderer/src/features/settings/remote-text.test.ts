import type { TFunction } from 'i18next'
import { describe, expect, it } from 'vitest'
import enSettings from '@shared/locales/en/settings.json'
import { deviceLine, systemLogoOf } from './remote-text'

function lookupPath(root: Record<string, unknown>, key: string): string {
  let current: unknown = root
  for (const part of key.split('.')) {
    if (!current || typeof current !== 'object' || !(part in current)) {
      throw new Error(`Missing key: ${key}`)
    }
    current = (current as Record<string, unknown>)[part]
  }
  return String(current)
}

const tEn = ((key: string) => lookupPath(enSettings, key)) as unknown as TFunction<'settings'>

describe('Settings device formatting consistency', () => {
  it('formats canonical and legacy device platforms identically to kettu pair', () => {
    const cases = [
      {
        kind: 'ios',
        model: 'iPhone 17 Pro',
        platform: 'ios',
        expected: 'iOS app · iPhone 17 Pro · iOS',
      },
      {
        kind: 'ios',
        model: 'iPhone 17 Pro',
        platform: 'iOS 26.1',
        expected: 'iOS app · iPhone 17 Pro · iOS 26.1',
      },
      {
        kind: 'android',
        model: 'Pixel 9',
        platform: 'android 15',
        expected: 'Android app · Pixel 9 · Android 15',
      },
      {
        kind: 'android',
        model: 'Pixel 9',
        platform: 'Android 15',
        expected: 'Android app · Pixel 9 · Android 15',
      },
      {
        kind: 'desktop',
        model: 'MacBook Pro',
        platform: 'macOS 27.0.1',
        expected: 'Desktop app · MacBook Pro · macOS 27.0.1',
      },
      {
        kind: 'desktop',
        model: '',
        platform: 'Windows 10.0.26100',
        expected: 'Desktop app · Windows 10.0.26100',
      },
      { kind: 'web', model: 'Safari', platform: 'iPhone', expected: 'Web · Safari · iOS' },
      { kind: 'web', model: 'Chrome', platform: 'Mac', expected: 'Web · Chrome · macOS' },
      { kind: 'web', model: 'Chrome', platform: 'web', expected: 'Web · Chrome · Web' },
      {
        kind: 'desktop',
        model: 'Workstation',
        platform: '',
        expected: 'Desktop app · Workstation',
      },
    ] as const

    for (const item of cases) {
      expect(deviceLine(tEn, item)).toBe(item.expected)
    }
  })

  it('picks system logos for canonical versioned platforms as well as legacy ones', () => {
    expect(systemLogoOf('iOS 26.1')).toBe('apple')
    expect(systemLogoOf('ios')).toBe('apple')
    expect(systemLogoOf('iPadOS 26.1')).toBe('apple')
    expect(systemLogoOf('macOS 27.0.1')).toBe('apple')
    expect(systemLogoOf('darwin')).toBe('apple')
    expect(systemLogoOf('Windows 10.0.26100')).toBe('windows')
    expect(systemLogoOf('win32')).toBe('windows')
    expect(systemLogoOf('Android 15')).toBe('android')
    expect(systemLogoOf('android 15')).toBe('android')
    expect(systemLogoOf('Ubuntu 24.04.1 LTS')).toBe('linux')
    expect(systemLogoOf('linux')).toBe('linux')
    expect(systemLogoOf('Web')).toBeNull()
    expect(systemLogoOf('')).toBeNull()
  })
})
