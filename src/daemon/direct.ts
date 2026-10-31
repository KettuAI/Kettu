// `kettu direct`: the port and the addresses devices connect to directly, as Settings shows them in
// the app, and a change of the port after the app's warning.

import type { DirectStatus } from '@shared/host-control'
import { addressKey, addressText } from '@shared/remote/address'
import type { DirectAddress } from '@shared/remote/protocol'
import type { ControlClient, DirectReport } from './control'

type Failed = Extract<DirectStatus, { state: 'failed' }>

/** Why the port could not be opened, as the app says it. */
const CANNOT_LISTEN: Record<Failed['reason'], string> = {
  port_in_use: 'another program is using it',
  not_permitted: 'the system did not allow it',
  other: 'something on this computer kept Kettu from it',
}

/** The line `kettu status` shows for direct connections. */
export function directLine(status: DirectStatus | null): string {
  if (!status) return 'unknown, remote access is not running'
  switch (status.state) {
    case 'off':
      return 'off'
    case 'failed':
      return `cannot listen on port ${status.port}, ${CANNOT_LISTEN[status.reason]}`
    case 'listening':
      return status.addresses.length === 0
        ? `listening on port ${status.port}, no private or VPN address found yet`
        : `listening on port ${status.port} at ${status.addresses.map(addressText).join(', ')}`
  }
}

function list(addresses: DirectAddress[], label: (address: DirectAddress) => string): string {
  const shown = addresses.map(addressText)
  const width = Math.max(...shown.map((text) => text.length))
  return shown
    .map((text, index) => `  ${text.padEnd(width)}  ${label(addresses[index]!)}`.trimEnd())
    .join('\n')
}

/** What `kettu direct` prints: the port and the addresses devices try, or why nothing listens. */
export function directReport(report: DirectReport): string {
  const { status, own } = report
  const yours = own.length > 0 ? `Your addresses:\n${list(own, () => '')}\n` : ''
  if (!status) {
    return (
      `Remote access is not running, so direct connections do not listen; the port is ${report.port}.\n` +
      yours
    )
  }
  switch (status.state) {
    case 'off':
      return `Direct connections are off.\n${yours}`
    case 'failed':
      return (
        `Direct connections cannot listen on port ${status.port}: ${CANNOT_LISTEN[status.reason]}.\n` +
        `Pick another port with kettu direct port <port>, or try this one again with\n` +
        `kettu direct port ${status.port}.\n` +
        yours
      )
    case 'listening': {
      const head = `Direct connections listen on port ${status.port}.\n`
      if (status.addresses.length === 0) {
        return (
          head +
          'No private or VPN address found yet; add one of your own with\n' +
          'kettu direct add <host>:<port>.\n'
        )
      }
      const owned = new Set(own.map(addressKey))
      const label = (address: DirectAddress): string =>
        owned.has(addressKey(address)) ? 'yours' : 'found on this computer'
      return `${head}Addresses devices try:\n${list(status.addresses, label)}\n`
    }
  }
}

/** What a new port means for devices, as the app warns before it changes. */
export function portWarning(port: number): string {
  return (
    `Direct connections move to port ${port}. Devices online get the new address, but devices that\n` +
    'are offline and only connect directly cannot find this computer until they scan a new code\n' +
    'or their address is changed. A port you forward has to change too.\n'
  )
}

export interface PortTerminal {
  write(text: string): void
  /** What kept the change from being made, as a line on stderr. */
  error(message: string): void
  /** Input is a terminal, where the owner can be asked. */
  interactive: boolean
  /** Asks a question; null once input ends. */
  ask(question: string): Promise<string | null>
}

/**
 * `kettu direct port`: warns what a new port means, asks unless `yes`, then moves the port or tries
 * the same one again. Resolves with the exit code: 0 once it listens, 1 when it does not.
 */
export async function changePort(
  client: Pick<ControlClient, 'call'>,
  terminal: PortTerminal,
  port: number,
  yes: boolean,
): Promise<number> {
  const current = await client.call('direct.get', undefined)
  if (current.port !== port) {
    terminal.write(portWarning(port))
    if (!yes) {
      if (!terminal.interactive) {
        terminal.error('Changing the port needs --yes when there is no terminal to ask on')
        return 1
      }
      const answer = await terminal.ask('Change the port? [y/N] ')
      if (answer === null || !/^y(es)?$/i.test(answer.trim())) {
        terminal.write(`The port stays ${current.port}.\n`)
        return 1
      }
    }
  } else if (current.status?.state !== 'listening') {
    terminal.write(`Trying port ${port} again.\n`)
  }
  const report = await client.call('direct.port', { port })
  terminal.write(directReport(report))
  return report.status?.state === 'listening' ? 0 : 1
}
