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
    [['update'], { kind: 'update' }],
    [['login'], { kind: 'login' }],
    [['logout'], { kind: 'logout' }],
    [['ssh-setup'], { kind: 'ssh-setup', request: null }],
    [['ssh-setup', '{"device":null}'], { kind: 'ssh-setup', request: '{"device":null}' }],
    [[], { kind: 'help' }],
    [['help'], { kind: 'help' }],
    [['--help'], { kind: 'help' }],
    [['-h'], { kind: 'help' }],
    [['status', '--help'], { kind: 'help' }],
    [['--version'], { kind: 'version' }],
    [['--version', '--help'], { kind: 'help' }],
    // An id that looks like an option comes after --.
    [['devices', 'remove', '--', '-x'], { kind: 'devices-remove', id: '-x' }],
    [['direct'], { kind: 'direct' }],
    [['direct', 'port', '4567'], { kind: 'direct-port', port: 4567, yes: false }],
    [['direct', 'port', '65535', '--yes'], { kind: 'direct-port', port: 65535, yes: true }],
    [['-y', 'direct', 'port', '1024'], { kind: 'direct-port', port: 1024, yes: true }],
    [
      ['direct', 'add', 'frp.example.com:60021'],
      { kind: 'direct-add', address: { host: 'frp.example.com', port: 60021 } },
    ],
    [
      ['direct', 'add', '[fd00::1]:4567'],
      { kind: 'direct-add', address: { host: 'fd00::1', port: 4567 } },
    ],
    [
      ['direct', 'remove', '192.0.2.10:4567'],
      { kind: 'direct-remove', address: { host: '192.0.2.10', port: 4567 } },
    ],
    [['direct', '--help'], { kind: 'help' }],
    [['terminal'], { kind: 'terminal' }],
    [['terminal', 'on'], { kind: 'terminal-set', allowed: true }],
    [['terminal', 'off'], { kind: 'terminal-set', allowed: false }],
    [['terminal', 'on', '--help'], { kind: 'help' }],
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
    [['ssh-setup', '{}', '{}'], "Unexpected argument '{}'"],
    [['update', '0.1.0'], "Unexpected argument '0.1.0'"],
    [['service'], 'Name install or uninstall'],
    [['service', 'start'], "Unknown service command 'start'"],
    [['service', 'install', 'now'], "Unexpected argument 'now'"],
    [['direct', 'list'], "Unknown direct command 'list'"],
    [['direct', 'now'], "Unknown direct command 'now'"],
    [['direct', 'port'], 'Name the port to listen on'],
    [['direct', 'port', '1023'], 'Use a port from 1024 to 65535'],
    [['direct', 'port', '65536'], 'Use a port from 1024 to 65535'],
    [['direct', 'port', 'http'], 'Use a port from 1024 to 65535'],
    [['direct', 'port', '4567', '4568'], "Unexpected argument '4568'"],
    [['direct', 'port', '4567', '--yes=no'], "'--yes' takes no value"],
    [['direct', 'add'], 'Name the address, as host:port'],
    [['direct', 'remove'], 'Name the address, as host:port'],
    [['direct', 'add', 'a.example:1', 'b.example:2'], "Unexpected argument 'b.example:2'"],
    [['direct', '--yes'], "'--yes' is only for kettu direct port"],
    [['direct', 'add', 'a.example:1', '-y'], "'-y' is only for kettu direct port"],
    [['status', '--yes'], "'--yes' is only for kettu direct port"],
    [['terminal', 'yes'], "Unknown terminal command 'yes'"],
    [['terminal', 'on', 'now'], "Unexpected argument 'now'"],
    [['terminal', 'off', '-y'], "'-y' is only for kettu direct port"],
  ])('refuses %j', (argv, message) => {
    expect(parseCommand(argv)).toEqual({ kind: 'usage', message })
  })
})

describe('an address of your own', () => {
  const ADDRESS =
    'Not an address: enter only a host name or IP address and a port, such as ' +
    'frp.example.com:60021, without https://'

  it.each([
    'https://frp.example.com:443',
    'frp.example.com',
    'frp.example.com:0',
    // IPv6 is written in brackets, so the port is not read as part of it.
    'fd00::1:4567',
    '[fd00::1]',
    '10.1:7000',
  ])('refuses %j as the app does', (address) => {
    expect(parseCommand(['direct', 'add', address])).toEqual({ kind: 'usage', message: ADDRESS })
    expect(parseCommand(['direct', 'remove', address])).toEqual({
      kind: 'usage',
      message: ADDRESS,
    })
  })
})
