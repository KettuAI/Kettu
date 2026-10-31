import { describe, expect, it } from 'vitest'
import { parseCommand } from './args'

describe('parseCommand', () => {
  it.each([
    [['run'], { kind: 'run' }],
    [['status'], { kind: 'status' }],
    [['devices'], { kind: 'devices' }],
    [['devices', 'remove', 'abc123'], { kind: 'devices-remove', id: 'abc123' }],
    [['pair'], { kind: 'pair' }],
    [['service', 'install'], { kind: 'service-install' }],
    [['service', 'uninstall'], { kind: 'service-uninstall' }],
    [[], { kind: 'help' }],
    [['help'], { kind: 'help' }],
    [['--help'], { kind: 'help' }],
    [['-h'], { kind: 'help' }],
    [['status', '--help'], { kind: 'help' }],
    [['--version'], { kind: 'version' }],
    [['--version', '--help'], { kind: 'help' }],
    // An id that looks like an option comes after --.
    [['devices', 'remove', '--', '-x'], { kind: 'devices-remove', id: '-x' }],
  ])('reads %j', (argv, command) => {
    expect(parseCommand(argv)).toEqual(command)
  })

  it.each([
    [['start'], "Unknown command 'start'"],
    [['--verbose'], "Unknown option '--verbose'"],
    [['status', '-x'], "Unknown option '-x'"],
    [['-v'], "Unknown option '-v'"],
    [['--help=yes'], "'--help' takes no value"],
    [['run', 'now'], "Unexpected argument 'now'"],
    [['status', 'all'], "Unexpected argument 'all'"],
    [['devices', 'list'], "Unknown devices command 'list'"],
    [['devices', 'remove'], "Name the device's id to remove"],
    [['devices', 'remove', 'a', 'b'], "Unexpected argument 'b'"],
    [['pair', 'iPad'], "Unexpected argument 'iPad'"],
    [['service'], 'Name install or uninstall'],
    [['service', 'start'], "Unknown service command 'start'"],
    [['service', 'install', 'now'], "Unexpected argument 'now'"],
  ])('refuses %j', (argv, message) => {
    expect(parseCommand(argv)).toEqual({ kind: 'usage', message })
  })
})
