// What a browser calls itself to the host: its model and canonical OS platform for the hello,
// and a suggested name such as "Safari · iPhone" the owner sees when asked to add it.

export interface BrowserDevice {
  /** The browser, as the host's device list shows the model. */
  browser: string
  /** The short device or OS label for the suggested name, as "iPhone" or "Mac". */
  system: string
  /** The canonical OS name for hello's `client.platform`, as "iOS", "macOS", or "Web". */
  platform: string
}

export function browserDevice(userAgent: string): BrowserDevice {
  const { system, platform } = systemInfoOf(userAgent)
  return { browser: browserOf(userAgent), system, platform }
}

/** The name a browser suggests for itself. */
export function deviceName(device: BrowserDevice): string {
  return device.system ? `${device.browser} · ${device.system}` : device.browser
}

function browserOf(agent: string): string {
  // Each tests what the ones after it would also match.
  if (/\bEdgA?\//.test(agent)) return 'Edge'
  if (/\b(Firefox|FxiOS)\//.test(agent)) return 'Firefox'
  if (/\b(Chrome|CriOS)\//.test(agent)) return 'Chrome'
  if (/\bSafari\//.test(agent)) return 'Safari'
  return 'Browser'
}

function systemInfoOf(agent: string): { system: string; platform: string } {
  if (/\biPhone\b/.test(agent)) return { system: 'iPhone', platform: 'iOS' }
  if (/\biPad\b/.test(agent)) return { system: 'iPad', platform: 'iPadOS' }
  if (/\biPod\b/.test(agent)) return { system: 'iPod', platform: 'iOS' }
  if (/\bAndroid\b/.test(agent)) return { system: 'Android', platform: 'Android' }
  if (/\bMac OS X\b|\bMacintosh\b/.test(agent)) return { system: 'Mac', platform: 'macOS' }
  if (/\bWindows\b/.test(agent)) return { system: 'Windows', platform: 'Windows' }
  if (/\bCrOS\b/.test(agent)) return { system: 'ChromeOS', platform: 'ChromeOS' }
  if (/\bLinux\b/.test(agent)) return { system: 'Linux', platform: 'Linux' }
  return { system: '', platform: 'Web' }
}
