// What `kettu status`, `kettu devices` and `kettu terminal` print.

import type { DaemonStatus, DeviceSummary, HostStatus } from './control'
import { directLine } from './direct'

function host(status: HostStatus): string {
  const restarted =
    status.restarts > 0
      ? `, restarted ${status.restarts} time${status.restarts > 1 ? 's' : ''}`
      : ''
  switch (status.state) {
    case 'idle':
      return 'not started'
    case 'starting':
      return `starting${restarted}`
    case 'ready':
      return `ready (pid ${status.pid}${restarted})`
    case 'waiting':
      return `restarting${restarted}`
    case 'failed':
      return `failed, it exited too often${restarted}`
    case 'stopping':
      return 'stopping'
    case 'stopped':
      return 'stopped'
  }
}

function rows(entries: [string, string][]): string {
  const width = Math.max(...entries.map(([label]) => label.length)) + 1
  return entries.map(([label, value]) => `${`${label}:`.padEnd(width)} ${value}`).join('\n')
}

/** `account`: the line `accountLine` gives. */
export function runningReport(status: DaemonStatus, account: string): string {
  const how = status.service ? 'as a service' : 'in the foreground'
  const state = status.stopping ? 'is stopping' : `is running ${how}`
  const key =
    status.key.private === null
      ? `not made yet, it goes in ${status.key.path}`
      : status.key.private
        ? `in a file only you can read, ${status.key.path}`
        : `in a file others can read too, ${status.key.path}`
  const devices =
    status.connectedDevices === null
      ? 'unknown, remote access is not running'
      : String(status.connectedDevices)
  return `Kettu daemon ${status.version} ${state} (pid ${status.pid})
${rows([
  ['Data folder', status.dataPath],
  ['Private key', key],
  ['Agent host', host(status.hosts.agent)],
  ['Terminal host', host(status.hosts.terminal)],
  ['Remote host', host(status.hosts.remote)],
  ['Connected devices', devices],
  ['Direct connections', directLine(status.direct)],
  ['Account', account],
])}
`
}

export function stoppedReport(version: string, dataPath: string, account: string): string {
  return `Kettu daemon is not running
${rows([
  ['Version', version],
  ['Data folder', dataPath],
  ['Account', account],
])}
`
}

export function devicesReport(devices: DeviceSummary[], now: number): string {
  if (devices.length === 0) return 'No devices are paired with this computer.\n'
  const table = [
    ['ID', 'NAME', 'KIND', 'PLATFORM', 'LAST CONNECTED'],
    ...devices.map((device) => [
      device.id,
      device.name,
      device.kind,
      device.platform,
      device.connected ? 'connected now' : since(device.lastConnectedAt, now),
    ]),
  ]
  const widths = table[0]!.map((_, column) => Math.max(...table.map((row) => row[column]!.length)))
  return (
    table
      .map((row) =>
        row
          .map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]!)))
          .join('  '),
      )
      .join('\n') + '\n'
  )
}

function since(at: number | null, now: number): string {
  if (at === null) return 'never'
  const minutes = Math.floor(Math.max(0, now - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.floor(hours / 24)} d ago`
}

/** Whether devices may use the terminal, as Settings › Remote access says it in the app. */
export function terminalReport(allowed: boolean): string {
  return allowed
    ? 'Devices may use the terminal: they can run any command on this computer, beyond what an\n' +
        'agent asks to run. kettu terminal off closes their terminals, which keep running here.\n'
    : 'Devices may not use the terminal. kettu terminal on lets them.\n'
}
