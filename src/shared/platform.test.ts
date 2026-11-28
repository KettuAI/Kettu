import { describe, expect, it } from 'vitest'
import { platformFamily, platformName } from './platform'

describe('platformName', () => {
  it('formats canonical and versioned platform strings consistently', () => {
    expect(platformName('macOS 27.0.1')).toBe('macOS 27.0.1')
    expect(platformName('iOS 26.1')).toBe('iOS 26.1')
    expect(platformName('iPadOS 26.1')).toBe('iPadOS 26.1')
    expect(platformName('Android 15')).toBe('Android 15')
    expect(platformName('Windows 10.0.26100')).toBe('Windows 10.0.26100')
    expect(platformName('Linux 6.8.0')).toBe('Linux 6.8.0')
    expect(platformName('Ubuntu 24.04.1 LTS')).toBe('Ubuntu 24.04.1 LTS')
    expect(platformName('ChromeOS')).toBe('ChromeOS')
    expect(platformName('Web')).toBe('Web')
  })

  it('normalizes legacy lowercase, process.platform and standalone hardware labels', () => {
    expect(platformName('ios')).toBe('iOS')
    expect(platformName('ios 26.1')).toBe('iOS 26.1')
    expect(platformName('ipados')).toBe('iPadOS')
    expect(platformName('ipados 26.1')).toBe('iPadOS 26.1')
    expect(platformName('android')).toBe('Android')
    expect(platformName('android 15')).toBe('Android 15')
    expect(platformName('darwin')).toBe('macOS')
    expect(platformName('darwin 24.0.0')).toBe('macOS 24.0.0')
    expect(platformName('macos')).toBe('macOS')
    expect(platformName('macos 27.0.1')).toBe('macOS 27.0.1')
    expect(platformName('win32')).toBe('Windows')
    expect(platformName('win32 10.0.26100')).toBe('Windows 10.0.26100')
    expect(platformName('windows')).toBe('Windows')
    expect(platformName('windows 11')).toBe('Windows 11')
    expect(platformName('linux')).toBe('Linux')
    expect(platformName('linux 6.8.0')).toBe('Linux 6.8.0')
    expect(platformName('chromeos')).toBe('ChromeOS')
    expect(platformName('cros')).toBe('ChromeOS')
    expect(platformName('web')).toBe('Web')
    expect(platformName('Mac')).toBe('macOS')
    expect(platformName('iPhone')).toBe('iOS')
    expect(platformName('iPad')).toBe('iPadOS')
  })

  it('keeps unknown values, multi-word hardware names and empty fallbacks clean', () => {
    expect(platformName('Mac OS X 10.15')).toBe('Mac OS X 10.15')
    expect(platformName('iPhone 17')).toBe('iPhone 17')
    expect(platformName('FreeBSD 14.2')).toBe('FreeBSD 14.2')
    expect(platformName('  ios   26.1  ')).toBe('iOS 26.1')
    expect(platformName('')).toBe('')
    expect(platformName('   ')).toBe('')
  })
})

describe('platformFamily', () => {
  it('identifies system logo families across canonical, versioned and legacy values', () => {
    expect(platformFamily('ios')).toBe('apple')
    expect(platformFamily('iOS 26.1')).toBe('apple')
    expect(platformFamily('ipados')).toBe('apple')
    expect(platformFamily('iPadOS 26.1')).toBe('apple')
    expect(platformFamily('darwin')).toBe('apple')
    expect(platformFamily('macOS')).toBe('apple')
    expect(platformFamily('macOS 27.0.1')).toBe('apple')
    expect(platformFamily('Mac')).toBe('apple')
    expect(platformFamily('iPhone')).toBe('apple')

    expect(platformFamily('win32')).toBe('windows')
    expect(platformFamily('Windows')).toBe('windows')
    expect(platformFamily('Windows 10.0.26100')).toBe('windows')

    expect(platformFamily('android')).toBe('android')
    expect(platformFamily('android 15')).toBe('android')
    expect(platformFamily('Android 15')).toBe('android')

    expect(platformFamily('linux')).toBe('linux')
    expect(platformFamily('Linux 6.8.0')).toBe('linux')
    expect(platformFamily('Ubuntu 24.04.1 LTS')).toBe('linux')
    expect(platformFamily('Fedora Linux 41')).toBe('linux')
    expect(platformFamily('Debian GNU/Linux 12 (bookworm)')).toBe('linux')
    expect(platformFamily('NixOS 25.05')).toBe('linux')

    expect(platformFamily('web')).toBeNull()
    expect(platformFamily('ChromeOS')).toBeNull()
    expect(platformFamily('FreeBSD')).toBeNull()
    expect(platformFamily('')).toBeNull()
  })
})
