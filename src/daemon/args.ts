// The `kettu` command line: one command, `--help` and `--version`, anything else a usage error.

import { parseArgs } from 'node:util'
import { parseAddress, parsePort } from '@shared/remote/address'
import type { DirectAddress } from '@shared/remote/protocol'
import { ADDRESS_PROBLEM, PORT_PROBLEM } from './control'

export type Command =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'run' }
  | { kind: 'status' }
  | { kind: 'devices' }
  | { kind: 'devices-remove'; id: string }
  | { kind: 'pair' }
  | { kind: 'direct' }
  /** `yes`: change it without asking. */
  | { kind: 'direct-port'; port: number; yes: boolean }
  | { kind: 'direct-add'; address: DirectAddress }
  | { kind: 'direct-remove'; address: DirectAddress }
  | { kind: 'terminal' }
  | { kind: 'terminal-set'; allowed: boolean }
  | { kind: 'service-install' }
  | { kind: 'service-uninstall' }
  | { kind: 'update' }
  | { kind: 'login' }
  | { kind: 'logout' }
  /** What was wrong with the command line, in a short sentence. */
  | { kind: 'usage'; message: string }

export const HELP = `Usage: kettu <command>

Runs Kettu's hosts on this computer, for Kettu's clients to connect to.

Commands:
  run                          Run the daemon in the foreground
  status                       Say whether the daemon is running, with its details
  devices                      List the devices paired with this computer
  devices remove <id>          Remove a paired device and close its sessions
  pair                         Add a device: show a code to scan, then confirm the device
  direct                       Show the port and the addresses devices connect to directly
  direct port <port>           Listen on another port, from 1024 to 65535
  direct add <host>:<port>     Add an address of your own, such as a forwarded port
  direct remove <host>:<port>  Remove an address of your own
  terminal                     Say whether devices may use this computer's terminal
  terminal on                  Let devices use the terminal, which runs any command
  terminal off                 Stop it; devices' terminals close but keep running here
  service install              Run the daemon as a service that starts with the computer
  service uninstall            Stop the service and remove it
  update                       Update to the latest release, and the service with it
  login                        Sign in to a Kettu account, confirmed in a browser on any device
  logout                       Sign out of the Kettu account

Options:
  -y, --yes                    Change the port without asking
  -h, --help                   Show this help
  --version                    Show the version

Environment:
  KETTU_DAEMON_DATA            The data folder to use instead of the default
  KETTU_ACCOUNT_URL            The account service to sign in to instead of https://www.kettu.sh

Write an IPv6 address in brackets, as [fd00::1]:4567.
kettu status and the direct and terminal commands exit with 3 when the daemon is not running.
`

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
  yes: { type: 'boolean', short: 'y' },
} as const

const quote = (value: string): string => `'${value}'`

export function parseCommand(argv: readonly string[]): Command {
  const { tokens } = parseArgs({
    args: [...argv],
    options: OPTIONS,
    allowPositionals: true,
    strict: false,
    tokens: true,
  })
  let help = false
  let version = false
  let yes: string | null = null
  const words: string[] = []
  for (const token of tokens) {
    if (token.kind === 'positional') {
      words.push(token.value)
    } else if (token.kind === 'option') {
      if (!Object.hasOwn(OPTIONS, token.name)) {
        return { kind: 'usage', message: `Unknown option ${quote(token.rawName)}` }
      }
      if (token.value !== undefined) {
        return { kind: 'usage', message: `${quote(token.rawName)} takes no value` }
      }
      if (token.name === 'help') help = true
      else if (token.name === 'version') version = true
      else yes = token.rawName
    }
  }
  if (help) return { kind: 'help' }
  if (version) return { kind: 'version' }

  const command = parseWords(words, yes !== null)
  if (yes !== null && command.kind !== 'direct-port' && command.kind !== 'usage') {
    return { kind: 'usage', message: `${quote(yes)} is only for kettu direct port` }
  }
  return command
}

function parseWords(words: string[], yes: boolean): Command {
  const [name, ...rest] = words
  const extra = (at: number): Command | null =>
    rest.length > at ? { kind: 'usage', message: `Unexpected argument ${quote(rest[at]!)}` } : null
  switch (name) {
    case undefined:
    case 'help':
      return extra(0) ?? { kind: 'help' }
    case 'run':
      return extra(0) ?? { kind: 'run' }
    case 'status':
      return extra(0) ?? { kind: 'status' }
    case 'update':
      return extra(0) ?? { kind: 'update' }
    case 'login':
      return extra(0) ?? { kind: 'login' }
    case 'logout':
      return extra(0) ?? { kind: 'logout' }
    case 'pair':
      return extra(0) ?? { kind: 'pair' }
    case 'devices':
      if (rest.length === 0) return { kind: 'devices' }
      if (rest[0] !== 'remove') {
        return { kind: 'usage', message: `Unknown devices command ${quote(rest[0]!)}` }
      }
      if (rest.length < 2) return { kind: 'usage', message: "Name the device's id to remove" }
      return extra(2) ?? { kind: 'devices-remove', id: rest[1]! }
    case 'direct':
      return parseDirect(rest, yes)
    case 'terminal':
      if (rest[0] === undefined) return { kind: 'terminal' }
      if (rest[0] !== 'on' && rest[0] !== 'off') {
        return { kind: 'usage', message: `Unknown terminal command ${quote(rest[0])}` }
      }
      return extra(1) ?? { kind: 'terminal-set', allowed: rest[0] === 'on' }
    case 'service':
      if (rest[0] === 'install') return extra(1) ?? { kind: 'service-install' }
      if (rest[0] === 'uninstall') return extra(1) ?? { kind: 'service-uninstall' }
      if (rest[0] === undefined) return { kind: 'usage', message: 'Name install or uninstall' }
      return { kind: 'usage', message: `Unknown service command ${quote(rest[0])}` }
    default:
      return { kind: 'usage', message: `Unknown command ${quote(name)}` }
  }
}

function parseDirect(rest: string[], yes: boolean): Command {
  const [action, value, extra] = rest
  if (action === undefined) return { kind: 'direct' }
  if (action !== 'port' && action !== 'add' && action !== 'remove') {
    return { kind: 'usage', message: `Unknown direct command ${quote(action)}` }
  }
  if (value === undefined) {
    return {
      kind: 'usage',
      message: action === 'port' ? 'Name the port to listen on' : 'Name the address, as host:port',
    }
  }
  if (extra !== undefined) return { kind: 'usage', message: `Unexpected argument ${quote(extra)}` }
  if (action === 'port') {
    const port = parsePort(value)
    return port === null
      ? { kind: 'usage', message: PORT_PROBLEM }
      : { kind: 'direct-port', port, yes }
  }
  const address = parseAddress(value)
  if (!address) return { kind: 'usage', message: ADDRESS_PROBLEM }
  return { kind: action === 'add' ? 'direct-add' : 'direct-remove', address }
}
