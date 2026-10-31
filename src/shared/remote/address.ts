// The owner's own direct addresses, such as a port forwarded to the host: a host name or an IP
// address, and a port. Main validates them in settings, the remote host again before it lists them.

import type { DirectAddress } from './protocol'

/** How many addresses of their own the owner may add. */
export const MAX_OWN_ADDRESSES = 10

const MAX_HOST_NAME = 253
const IPV4_PART = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)'
const IPV4 = new RegExp(`^(?:${IPV4_PART}\\.){3}${IPV4_PART}$`)
const IPV6_CHARS = /^[0-9a-f:.]+$/i
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/i

/** A TCP port, 1 to 65535. */
export function isPort(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 65535
}

/** An IPv4 or IPv6 address, or an ASCII host name such as studio.example.ts.net. */
export function isDirectHost(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_HOST_NAME) return false
  if (IPV4.test(value)) return true
  if (value.includes(':')) return IPV6_CHARS.test(value) && URL.parse(`http://[${value}]/`) !== null
  const labels = value.split('.')
  // A name ending in a number would be read as an IPv4 address, as 10.1 is.
  return labels.every((label) => LABEL.test(label)) && !/^\d+$/.test(labels.at(-1)!)
}

/** The address as it is kept, or null when it is not one. Other fields are dropped. */
export function parseDirectAddress(value: unknown): DirectAddress | null {
  if (typeof value !== 'object' || value === null) return null
  const { host, port } = value as Record<string, unknown>
  return isDirectHost(host) && isPort(port) ? { host, port } : null
}

/** One key per address, the same for a host name in another case. */
export function addressKey(address: DirectAddress): string {
  return `${address.host.toLowerCase()} ${address.port}`
}
