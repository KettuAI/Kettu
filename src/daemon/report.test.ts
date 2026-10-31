import { describe, expect, it } from 'vitest'
import type { DaemonStatus } from './control'
import { devicesReport, runningReport, stoppedReport } from './report'

const status: DaemonStatus = {
  version: '0.1.0',
  pid: 4242,
  startedAt: 0,
  stopping: false,
  dataPath: '/home/ada/.local/share/kettu',
  service: true,
  key: { storage: 'file', path: '/home/ada/.local/share/kettu/host.key', private: true },
  hosts: {
    agent: { state: 'ready', pid: 4243, restarts: 0 },
    terminal: { state: 'idle', pid: null, restarts: 0 },
    remote: { state: 'ready', pid: 4244, restarts: 0 },
  },
  connectedDevices: 0,
  direct: {
    state: 'listening',
    port: 51234,
    addresses: [
      { host: '192.0.2.10', port: 51234 },
      { host: 'fd00::1', port: 51234 },
    ],
  },
}

describe('runningReport', () => {
  it('says the daemon runs, where its data and key are, and how its hosts are', () => {
    expect(runningReport(status)).toBe(`Kettu daemon 0.1.0 is running as a service (pid 4242)
Data folder:        /home/ada/.local/share/kettu
Private key:        in a file only you can read, /home/ada/.local/share/kettu/host.key
Agent host:         ready (pid 4243)
Terminal host:      not started
Remote host:        ready (pid 4244)
Connected devices:  0
Direct connections: listening on port 51234 at 192.0.2.10:51234, [fd00::1]:51234
`)
  })

  it('says how a host fared and how many devices are connected', () => {
    const report = runningReport({
      ...status,
      service: false,
      key: { ...status.key, private: false },
      hosts: {
        agent: { state: 'ready', pid: 7, restarts: 1 },
        terminal: { state: 'failed', pid: null, restarts: 4 },
        remote: { state: 'waiting', pid: null, restarts: 1 },
      },
      connectedDevices: null,
      direct: null,
    })
    expect(report).toContain('is running in the foreground (pid 4242)')
    expect(report).toContain('Private key:        in a file others can read too, ')
    expect(report).toContain('Agent host:         ready (pid 7, restarted 1 time)')
    expect(report).toContain('Terminal host:      failed, it exited too often, restarted 4 times')
    expect(report).toContain('Remote host:        restarting, restarted 1 time')
    expect(report).toContain('Connected devices:  unknown, remote access is not running')
    expect(report).toContain('Direct connections: unknown, remote access is not running')
  })

  it('says why direct connections cannot listen, or that they found no address', () => {
    const line = (direct: DaemonStatus['direct']): string | undefined =>
      runningReport({ ...status, direct })
        .split('\n')
        .find((row) => row.startsWith('Direct connections:'))
    expect(line({ state: 'failed', port: 51234, reason: 'port_in_use' })).toBe(
      'Direct connections: cannot listen on port 51234, another program is using it',
    )
    expect(line({ state: 'failed', port: 4567, reason: 'not_permitted' })).toBe(
      'Direct connections: cannot listen on port 4567, the system did not allow it',
    )
    expect(line({ state: 'listening', port: 4567, addresses: [] })).toBe(
      'Direct connections: listening on port 4567, no private or VPN address found yet',
    )
    expect(line({ state: 'off' })).toBe('Direct connections: off')
  })

  it('says when it is stopping', () => {
    expect(runningReport({ ...status, stopping: true })).toMatch(/^Kettu daemon 0.1.0 is stopping/)
  })
})

describe('stoppedReport', () => {
  it('names the version and the data folder', () => {
    expect(stoppedReport('0.1.0', '/data')).toBe(
      'Kettu daemon is not running\nVersion:     0.1.0\nData folder: /data\n',
    )
  })
})

describe('devicesReport', () => {
  const now = Date.UTC(2026, 9, 31, 12)

  it('says when there are none', () => {
    expect(devicesReport([], now)).toBe('No devices are paired with this computer.\n')
  })

  it('lists each device with when it last connected', () => {
    const devices = [
      {
        id: 'a1',
        name: "Ada's iPhone",
        kind: 'ios',
        platform: 'ios',
        connected: true,
        lastConnectedAt: now,
      },
      {
        id: 'b2b2',
        name: 'Laptop',
        kind: 'desktop',
        platform: 'darwin',
        connected: false,
        lastConnectedAt: null,
      },
      {
        id: 'c3',
        name: 'Web',
        kind: 'web',
        platform: 'web',
        connected: false,
        lastConnectedAt: now - 3 * 3_600_000,
      },
    ]
    expect(devicesReport(devices, now)).toBe(
      [
        'ID    NAME          KIND     PLATFORM  LAST CONNECTED',
        "a1    Ada's iPhone  ios      ios       connected now",
        'b2b2  Laptop        desktop  darwin    never',
        'c3    Web           web      web       3 h ago',
        '',
      ].join('\n'),
    )
  })
})
