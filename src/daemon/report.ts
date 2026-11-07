// What `kettu status`, `kettu devices` and `kettu terminal` print.

import type { RelayStatus } from '@shared/remote/relay-host'
import type { RelayReport } from '@shared/remote/status'
import type { DaemonStatus, DeviceSummary, HostStatus } from './control'
import { directLine } from './direct'

/** Why a relay did not sign the host in, as Settings says it. */
const RELAY_ERRORS: Record<string, string> = {
  unauthorized: 'it refused the key or the sign-in',
  forbidden: 'it refused the account',
  too_many: 'too many connections',
  unreachable: 'it cannot be reached',
  no_answer: 'it stopped answering',
  replaced: 'another copy of Kettu signed in as this computer',
}

function relayLine({ connection }: RelayStatus): string {
  switch (connection.state) {
    case 'connecting':
      return 'connecting'
    case 'connected':
      return 'connected'
    case 'conflict':
      return (
        'stopped: another copy of Kettu signs in as this computer; ' +
        'Retry in Settings › Remote access, or restart the daemon'
      )
    case 'retrying':
    case 'refused':
      return `retrying, ${RELAY_ERRORS[connection.error] ?? `closed (${connection.error})`}`
  }
}

/** The rows `kettu status` shows for the relay: one per region while it is used. */
function relayRows(relay: RelayReport | undefined): [string, string][] {
  if (!relay) return []
  if (relay.state === 'off') return [['Kettu relay', 'off, devices connect directly']]
  if (relay.state === 'signed_out') {
    return [['Kettu relay', 'not signed in; kettu login reaches this computer from anywhere']]
  }
  if (relay.relays.length === 0) return [['Kettu relay', 'starting']]
  return relay.relays.map((entry) => [`Relay ${entry.id}`, relayLine(entry)])
}

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
  ...relayRows(status.relay),
  ['Account', account],
])}
${status.debug ? debugReport(status.debug) : ''}`
}

/** A debug run's inspectors, which anything on this computer can connect to without a password. */
function debugReport(debug: NonNullable<DaemonStatus['debug']>): string {
  const inspectors = debug.inspectors.map(({ name, url }): [string, string] => [name, url])
  return `
Debug mode is on until the next restart. Its inspectors listen on 127.0.0.1 without a password:
${rows(inspectors.length > 0 ? inspectors : [['Inspectors', 'none open yet']])}
${debug.file ? `They are also listed in ${debug.file}.\n` : ''}`
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
