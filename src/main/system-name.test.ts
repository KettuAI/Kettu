import { describe, expect, it } from 'vitest'
import { isDeviceField, MAX_DEVICE_FIELD } from '@shared/remote/device'
import { devicePlatform, systemRelease } from './system-name'

describe('systemRelease and devicePlatform', () => {
  it('formats desktop OS releases with versions when known', () => {
    expect(systemRelease('darwin', '27.0.1', null)).toBe('macOS 27.0.1')
    expect(systemRelease('win32', '10.0.26100', null)).toBe('Windows 10.0.26100')
    expect(systemRelease('linux', '6.8.0', 'PRETTY_NAME="Ubuntu 24.04.1 LTS"\n')).toBe(
      'Ubuntu 24.04.1 LTS',
    )
    expect(systemRelease('linux', '6.8.0', null)).toBe('Linux 6.8.0')
  })

  it('omits trailing spaces when no OS version is available', () => {
    expect(systemRelease('darwin', '', null)).toBe('macOS')
    expect(systemRelease('win32', '   ', null)).toBe('Windows')
    expect(systemRelease('linux', '', null)).toBe('Linux')
  })

  it('keeps devicePlatform within the wire field limit', () => {
    const longPrettyName = `PRETTY_NAME="${'Custom Enterprise Linux Distribution '.repeat(3)}"\n`
    const value = devicePlatform('linux', '6.8.0', longPrettyName)
    expect(value.length).toBeLessThanOrEqual(MAX_DEVICE_FIELD)
    expect(isDeviceField(value)).toBe(true)
    expect(devicePlatform('darwin', '27.0.1', null)).toBe('macOS 27.0.1')
    expect(devicePlatform('win32', '', null)).toBe('Windows')
  })
})
