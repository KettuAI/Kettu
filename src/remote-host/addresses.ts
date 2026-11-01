// The direct addresses a host tells its devices: the owner's own first, then those of its own
// interfaces that a device on the same network or VPN can reach.

import { isIPv4, isIPv6 } from 'node:net'
import type { NetworkInterfaceInfo } from 'node:os'
import { addressKey, MAX_OWN_ADDRESSES, parseDirectAddress } from '@shared/remote/address'
import type { DirectAddress } from '@shared/remote/protocol'

export type Interfaces = NodeJS.Dict<NetworkInterfaceInfo[]>

// VPN interfaces: utun on macOS; tun, wg, zt and tailscale0 on Linux; the VPN's name on Windows.
const VPN_INTERFACE = /^(utun|tun|tap|wg|zt|ppp|ipsec)|tailscale|wireguard|zerotier|openvpn/i

// Bridges to containers and virtual machines, which no device reaches. Case matters, so Hyper-V's
// vEthernet on Windows, which may carry the computer's own network, stays.
const VIRTUAL_BRIDGE = /^(docker|br-|virbr|veth|vmnet|vboxnet)|^bridge\d+$/

/** Keeps the welcome small on a host with many interfaces, as one with many container networks. */
const MAX_FOUND = 16

function ipv4Octets(address: string): number[] {
  return address.split('.').map(Number)
}

/** The first 16 bits of an IPv6 address. */
function ipv6Head(address: string): number {
  return address.startsWith('::') ? 0 : parseInt(address.split(':')[0]!, 16)
}

/**
 * Loopback, link-local, unspecified and multicast, and the benchmarking range 198.18/15 that proxy
 * tools hand out as fake IPs on their TUN interfaces: never reachable from another device.
 */
function unreachable(address: string): boolean {
  if (isIPv4(address)) {
    const [a, b] = ipv4Octets(address) as [number, number]
    return (
      a === 0 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    )
  }
  const head = ipv6Head(address)
  return (
    address === '::' ||
    address === '::1' ||
    (head & 0xffc0) === 0xfe80 ||
    (head & 0xff00) === 0xff00
  )
}

/** Private IPv4, the 100.64/10 range Tailscale uses, and unique local IPv6. */
function isPrivate(address: string): boolean {
  if (isIPv4(address)) {
    const [a, b] = ipv4Octets(address) as [number, number]
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    )
  }
  return (ipv6Head(address) & 0xfe00) === 0xfc00
}

/** The addresses on the host's interfaces a device may reach it at, on `port`. */
export function findAddresses(interfaces: Interfaces, port: number): DirectAddress[] {
  const found: DirectAddress[] = []
  for (const [name, list] of Object.entries(interfaces)) {
    if (VIRTUAL_BRIDGE.test(name)) continue
    const vpn = VPN_INTERFACE.test(name)
    for (const info of list ?? []) {
      const host = info.address
      if (info.internal || (!isIPv4(host) && !isIPv6(host)) || unreachable(host)) continue
      if (vpn || isPrivate(host)) found.push({ host, port })
    }
  }
  return unique(found).slice(0, MAX_FOUND)
}

/** What devices are told: the owner's valid addresses first, then the found ones, each once. */
export function directAddresses(own: unknown[], found: DirectAddress[]): DirectAddress[] {
  const owned = own.flatMap((entry) => parseDirectAddress(entry) ?? []).slice(0, MAX_OWN_ADDRESSES)
  return unique([...owned, ...found])
}

function unique(addresses: DirectAddress[]): DirectAddress[] {
  const seen = new Set<string>()
  return addresses.filter((address) => {
    const key = addressKey(address)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
