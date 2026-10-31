// The owner's own direct addresses, such as a port forwarded to the host: a host name or an IP
// address, and a port. Main validates them in settings, the remote host again before it lists them;
// the app and the daemon read them as the owner types them.

import type { DirectStatus } from '../host-control'
import type { DirectAddress } from './protocol'

/** How many addresses of their own the owner may add. */
export const MAX_OWN_ADDRESSES = 10

/** The lowest port the owner may pick: below it a port may need privileges. */
export const MIN_OWN_PORT = 1024

/** The most addresses a direct status may list: the owner's and the ones the host found. */
const MAX_LISTED = 64

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

/** An address as devices dial it: an IPv6 address in brackets, then the port. */
export function addressText({ host, port }: DirectAddress): string {
  return `${host.includes(':') ? `[${host}]` : host}:${port}`
}

const ADDRESS_INPUT = /^(?:\[([^\]]+)\]|([^\s:/[\]]+)):(\d{1,5})$/

/** What the owner typed as an address of their own: `host:port` or `[IPv6]:port`, else null. */
export function parseAddress(text: string): DirectAddress | null {
  const match = ADDRESS_INPUT.exec(text.trim())
  if (!match) return null
  const host = match[1] ?? match[2]!
  const port = Number(match[3])
  return isDirectHost(host) && isPort(port) ? { host, port } : null
}

/** The port the owner typed, or null when it is not one they may pick. */
export function parsePort(text: string): number | null {
  const trimmed = text.trim()
  if (!/^\d{1,5}$/.test(trimmed)) return null
  const port = Number(trimmed)
  return isPort(port) && port >= MIN_OWN_PORT ? port : null
}

/** Direct connections as the remote host reports them, checked before main or the daemon uses them. */
export function isDirectStatus(value: unknown): value is DirectStatus {
  if (typeof value !== 'object' || value === null) return false
  const { state, port, addresses, reason } = value as Record<string, unknown>
  if (state === 'off') return true
  if (state === 'failed') {
    return isPort(port) && ['port_in_use', 'not_permitted', 'other'].includes(reason as string)
  }
  return (
    state === 'listening' &&
    isPort(port) &&
    Array.isArray(addresses) &&
    addresses.length <= MAX_LISTED &&
    addresses.every((address) => parseDirectAddress(address) !== null)
  )
}
