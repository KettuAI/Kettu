import type { NetworkInterfaceInfo } from 'node:os'
import { describe, expect, it } from 'vitest'
import { directAddresses, findAddresses, type Interfaces } from './addresses'

function info(address: string, internal = false): NetworkInterfaceInfo {
  const family = address.includes(':') ? 'IPv6' : 'IPv4'
  const base = { address, internal, netmask: '', mac: '00:00:00:00:00:00', cidr: null }
  return family === 'IPv6' ? { ...base, family, scopeid: 0 } : { ...base, family }
}

describe('findAddresses', () => {
  it.each([
    // Private IPv4 on any interface
    ['en0', '192.168.1.20', true],
    ['eth0', '10.0.0.5', true],
    ['Ethernet', '172.16.0.1', true],
    ['en0', '172.31.255.254', true],
    ['Wi-Fi', '172.32.0.1', false],
    ['en0', '172.15.0.1', false],
    // Tailscale's 100.64/10
    ['en0', '100.64.0.1', true],
    ['en0', '100.127.255.254', true],
    ['en0', '100.128.0.1', false],
    // Unique local IPv6
    ['en0', 'fd7a:115c:a1e0::1', true],
    ['en0', 'fc00::1', true],
    // Public addresses only on a VPN's interface
    ['en0', '203.0.113.7', false],
    ['en0', '2001:db8::1', false],
    ['utun4', '203.0.113.7', true],
    ['tun0', '198.51.100.2', true],
    ['wg0', '2001:db8::7', true],
    ['tailscale0', '203.0.113.9', true],
    ['zt5u4y2', '203.0.113.10', true],
    ['Tailscale', '203.0.113.11', true],
    ['WireGuard Tunnel', '203.0.113.12', true],
    ['ZeroTier One [8056c2e21c000001]', '203.0.113.13', true],
    // Never loopback, link-local, unspecified or multicast, not even on a VPN
    ['lo0', '127.0.0.1', false],
    ['utun0', '127.0.0.2', false],
    ['en0', '169.254.10.1', false],
    ['utun1', 'fe80::1234', false],
    ['en0', 'fe80::1', false],
    ['utun2', '::1', false],
    ['wg0', '0.0.0.0', false],
    ['wg0', '239.1.1.1', false],
    ['wg0', 'ff02::1', false],
    // Never the fake IPs a proxy tool's TUN interface hands out, in 198.18.0.0/15
    ['utun4', '198.18.0.1', false],
    ['utun5', '198.19.255.254', false],
    ['en0', '198.18.0.1', false],
    ['utun4', '198.17.255.254', true],
    ['utun4', '198.20.0.1', true],
    // Never a bridge to containers or virtual machines
    ['docker0', '172.17.0.1', false],
    ['br-3f9a2c1d7e60', '172.18.0.1', false],
    ['virbr0', '192.168.122.1', false],
    ['veth1a2b3c4', '10.200.0.1', false],
    ['vmnet8', '192.168.200.1', false],
    ['vboxnet0', '192.168.56.1', false],
    ['bridge100', '192.168.64.1', false],
    ['bridge0', 'fd00::64', false],
    // Names that only look like one, as Hyper-V's switch to the computer's own network
    ['vEthernet (External)', '192.168.1.30', true],
    ['bridged', '192.168.1.31', true],
  ])('on %s, %s is listed: %s', (name, address, listed) => {
    const found = findAddresses({ [name]: [info(address)] }, 50123)
    expect(found).toEqual(listed ? [{ host: address, port: 50123 }] : [])
  })

  it('skips internal addresses and lists each address once, in the interfaces order', () => {
    const interfaces: Interfaces = {
      lo0: [info('10.0.0.9', true)],
      en0: [info('192.168.1.20'), info('fe80::1'), info('fd00::20')],
      en1: [info('192.168.1.20')],
      utun3: [info('100.100.1.2')],
    }
    expect(findAddresses(interfaces, 50123)).toEqual([
      { host: '192.168.1.20', port: 50123 },
      { host: 'fd00::20', port: 50123 },
      { host: '100.100.1.2', port: 50123 },
    ])
  })

  it('lists at most 16 addresses', () => {
    const many = Array.from({ length: 20 }, (_, i) => info(`10.0.${i}.1`))
    expect(findAddresses({ eth0: many }, 1)).toHaveLength(16)
  })
})

describe('directAddresses', () => {
  it("lists the owner's own first, then the found ones, each once", () => {
    const found = [
      { host: '192.168.1.20', port: 50123 },
      { host: 'fd00::20', port: 50123 },
    ]
    const own = [
      { host: 'frp.example.com', port: 7000 },
      { host: 'not a host', port: 7000 },
      { host: '192.168.1.20', port: 50123 },
      { host: 'FRP.example.com', port: 7000 },
    ]
    expect(directAddresses(own, found)).toEqual([
      { host: 'frp.example.com', port: 7000 },
      { host: '192.168.1.20', port: 50123 },
      { host: 'fd00::20', port: 50123 },
    ])
  })
})
