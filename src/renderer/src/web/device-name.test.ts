import { describe, expect, it } from 'vitest'
import { browserDevice, deviceName } from './device-name'

describe('browserDevice', () => {
  it('maps desktop and mobile browsers to canonical OS platforms while keeping friendly names', () => {
    const safariIphone = browserDevice(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1',
    )
    expect(safariIphone).toEqual({ browser: 'Safari', system: 'iPhone', platform: 'iOS' })
    expect(deviceName(safariIphone)).toBe('Safari · iPhone')

    const safariIpad = browserDevice(
      'Mozilla/5.0 (iPad; CPU OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1',
    )
    expect(safariIpad).toEqual({ browser: 'Safari', system: 'iPad', platform: 'iPadOS' })
    expect(deviceName(safariIpad)).toBe('Safari · iPad')

    const chromeMac = browserDevice(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    )
    expect(chromeMac).toEqual({ browser: 'Chrome', system: 'Mac', platform: 'macOS' })
    expect(deviceName(chromeMac)).toBe('Chrome · Mac')

    const edgeWindows = browserDevice(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36 Edg/135.0.0.0',
    )
    expect(edgeWindows).toEqual({ browser: 'Edge', system: 'Windows', platform: 'Windows' })
    expect(deviceName(edgeWindows)).toBe('Edge · Windows')

    const chromeAndroid = browserDevice(
      'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Mobile Safari/537.36',
    )
    expect(chromeAndroid).toEqual({ browser: 'Chrome', system: 'Android', platform: 'Android' })
    expect(deviceName(chromeAndroid)).toBe('Chrome · Android')

    const chromeOs = browserDevice(
      'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    )
    expect(chromeOs).toEqual({ browser: 'Chrome', system: 'ChromeOS', platform: 'ChromeOS' })
    expect(deviceName(chromeOs)).toBe('Chrome · ChromeOS')

    const firefoxLinux = browserDevice(
      'Mozilla/5.0 (X11; Linux x86_64; rv:136.0) Gecko/20100101 Firefox/136.0',
    )
    expect(firefoxLinux).toEqual({ browser: 'Firefox', system: 'Linux', platform: 'Linux' })
    expect(deviceName(firefoxLinux)).toBe('Firefox · Linux')
  })

  it('falls back to Web when the user agent names no known OS', () => {
    const unknown = browserDevice('CustomClient/1.0')
    expect(unknown).toEqual({ browser: 'Browser', system: '', platform: 'Web' })
    expect(deviceName(unknown)).toBe('Browser')
  })
})
