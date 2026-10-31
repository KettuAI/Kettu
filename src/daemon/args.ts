// The `kettu` command line: one command, `--help` and `--version`, anything else a usage error.

import { parseArgs } from 'node:util'

export type Command =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'run' }
  | { kind: 'status' }
  | { kind: 'devices' }
  | { kind: 'devices-remove'; id: string }
  | { kind: 'service-install' }
  | { kind: 'service-uninstall' }
  /** What was wrong with the command line, in a short sentence. */
  | { kind: 'usage'; message: string }

export const HELP = `Usage: kettu <command>

Runs Kettu's hosts on this computer, for Kettu's clients to connect to.

Commands:
  run                  Run the daemon in the foreground
  status               Say whether the daemon is running, with its details
  devices              List the devices paired with this computer
  devices remove <id>  Remove a paired device and close its sessions
  service install      Run the daemon as a service that starts with the computer
  service uninstall    Stop the service and remove it

Options:
  -h, --help           Show this help
  --version            Show the version

Environment:
  KETTU_DAEMON_DATA    The data folder to use instead of the default

kettu status exits with 3 when the daemon is not running.
`

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
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
      else version = true
    }
  }
  if (help) return { kind: 'help' }
  if (version) return { kind: 'version' }

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
    case 'devices':
      if (rest.length === 0) return { kind: 'devices' }
      if (rest[0] !== 'remove') {
        return { kind: 'usage', message: `Unknown devices command ${quote(rest[0]!)}` }
      }
      if (rest.length < 2) return { kind: 'usage', message: "Name the device's id to remove" }
      return extra(2) ?? { kind: 'devices-remove', id: rest[1]! }
    case 'service':
      if (rest[0] === 'install') return extra(1) ?? { kind: 'service-install' }
      if (rest[0] === 'uninstall') return extra(1) ?? { kind: 'service-uninstall' }
      if (rest[0] === undefined) return { kind: 'usage', message: 'Name install or uninstall' }
      return { kind: 'usage', message: `Unknown service command ${quote(rest[0])}` }
    default:
      return { kind: 'usage', message: `Unknown command ${quote(name)}` }
  }
}
