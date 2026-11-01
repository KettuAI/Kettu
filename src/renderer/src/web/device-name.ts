// What a browser calls itself to the host: its kind for the hello, and a name such as
// "Safari · iPhone" the owner sees when asked to add it.

export interface BrowserDevice {
  /** The browser, as the host's device list shows the model. */
  browser: string
  /** The system, as the hello's platform. */
  system: string
}

export function browserDevice(userAgent: string): BrowserDevice {
  return { browser: browserOf(userAgent), system: systemOf(userAgent) }
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

function systemOf(agent: string): string {
  if (/\biPhone\b/.test(agent)) return 'iPhone'
  if (/\biPad\b/.test(agent)) return 'iPad'
  if (/\bAndroid\b/.test(agent)) return 'Android'
  if (/\bMac OS X\b|\bMacintosh\b/.test(agent)) return 'Mac'
  if (/\bWindows\b/.test(agent)) return 'Windows'
  if (/\bCrOS\b/.test(agent)) return 'ChromeOS'
  if (/\bLinux\b/.test(agent)) return 'Linux'
  return ''
}
