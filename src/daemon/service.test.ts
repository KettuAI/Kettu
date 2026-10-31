import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  installService,
  launchAgent,
  serviceCommand,
  serviceFile,
  systemdUnit,
  uninstallService,
  type CommandResult,
  type ServiceDeps,
} from './service'

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'kettu-daemon-service-'))
})

afterEach(() => rm(dir, { recursive: true, force: true }))

const command = {
  program: '/opt/node 24/bin/node',
  args: ['/opt/kettu/out/daemon/main.cjs', 'run'],
  env: { KETTU_DAEMON_SERVICE: '1' },
}

const exists = (file: string): Promise<boolean> =>
  stat(file).then(
    () => true,
    () => false,
  )

/** Service tools that run nothing: each call is recorded and answered from `answers`. */
function deps(
  platform: 'darwin' | 'linux',
  answers: Record<string, Partial<CommandResult>> = {},
): ServiceDeps & { calls: string[] } {
  const calls: string[] = []
  return {
    platform,
    home: dir,
    env: { USER: 'ada' },
    uid: 501,
    dir: path.join(dir, 'services'),
    calls,
    run: async (tool, args) => {
      const line = [tool, ...args].join(' ')
      calls.push(line)
      return { code: 0, stdout: '', stderr: '', ...answers[line] }
    },
  }
}

describe('serviceCommand', () => {
  it('runs `run` with the program and script, marked as the service', () => {
    expect(serviceCommand('/n/node', '/k/main.cjs', {}, 'KETTU_DAEMON_SERVICE')).toEqual({
      program: '/n/node',
      args: ['/k/main.cjs', 'run'],
      env: { KETTU_DAEMON_SERVICE: '1' },
    })
  })

  it('keeps a data folder named at install time', () => {
    const data = path.resolve('/data/kettu')
    const env = { KETTU_DAEMON_DATA: data }
    expect(serviceCommand('/n', '/k', env, 'S').env).toEqual({ S: '1', KETTU_DAEMON_DATA: data })
  })
})

describe('the default service files', () => {
  it('are a user unit on Linux and a LaunchAgent on macOS', () => {
    const base = {
      home: '/home/ada',
      uid: 501,
      run: async () => ({ code: 0, stdout: '', stderr: '' }),
    }
    expect(serviceFile({ ...base, platform: 'linux', env: {} })).toBe(
      path.join('/home/ada', '.config', 'systemd', 'user', 'kettu.service'),
    )
    expect(serviceFile({ ...base, platform: 'linux', env: { XDG_CONFIG_HOME: '/cfg' } })).toBe(
      path.join('/cfg', 'systemd', 'user', 'kettu.service'),
    )
    expect(serviceFile({ ...base, platform: 'darwin', env: {} })).toBe(
      path.join('/home/ada', 'Library', 'LaunchAgents', 'sh.kettu.daemon.plist'),
    )
  })
})

describe('systemdUnit', () => {
  it('runs the daemon, restarts it whenever it exits and starts with the user manager', () => {
    expect(systemdUnit(command)).toBe(`[Unit]
Description=Kettu daemon
Documentation=https://github.com/KettuAI/Kettu

[Service]
Type=simple
ExecStart="/opt/node 24/bin/node" "/opt/kettu/out/daemon/main.cjs" "run"
Environment="KETTU_DAEMON_SERVICE=1"
Restart=always
RestartSec=2
# SIGTERM to the daemon alone, which stops its hosts in order; SIGKILL to what is left at the end.
KillMode=mixed

[Install]
WantedBy=default.target
`)
  })

  it('escapes what systemd would expand or split', () => {
    const unit = systemdUnit({ program: '/a "b"\\c', args: ['50%', '$HOME'], env: {} })
    expect(unit).toContain('ExecStart="/a \\"b\\"\\\\c" "50%%" "$$HOME"')
  })
})

describe('launchAgent', () => {
  it('runs the daemon at login, keeps it alive and sends its output to the log', () => {
    const plist = launchAgent(command, '/data/logs/daemon.log')
    expect(plist).toContain('<key>Label</key>\n\t<string>sh.kettu.daemon</string>')
    expect(plist).toContain(
      '<array>\n\t\t<string>/opt/node 24/bin/node</string>\n' +
        '\t\t<string>/opt/kettu/out/daemon/main.cjs</string>\n\t\t<string>run</string>\n\t</array>',
    )
    expect(plist).toContain(
      '<key>EnvironmentVariables</key>\n\t<dict>\n\t\t<key>KETTU_DAEMON_SERVICE</key>\n' +
        '\t\t<string>1</string>\n\t</dict>',
    )
    expect(plist).toContain('<key>RunAtLoad</key>\n\t<true/>')
    expect(plist).toContain('<key>KeepAlive</key>\n\t<true/>')
    // launchd's 5 s would cut short the hosts' stop, which can take 6 s and a kill's 2 s.
    expect(plist).toContain('<key>ExitTimeOut</key>\n\t<integer>20</integer>')
    expect(plist).toContain('<key>StandardOutPath</key>\n\t<string>/data/logs/daemon.log</string>')
    expect(plist).toContain(
      '<key>StandardErrorPath</key>\n\t<string>/data/logs/daemon.log</string>',
    )
  })

  it('escapes XML', () => {
    const plist = launchAgent({ program: '/a&b<c>"', args: [], env: {} }, '/l')
    expect(plist).toContain('<string>/a&amp;b&lt;c&gt;&quot;</string>')
  })
})

describe('on Linux', () => {
  it('installs the unit, enables and starts it, and turns on linger', async () => {
    const tools = deps('linux')
    const installed = await installService(tools, command, path.join(dir, 'data'))
    expect(installed).toEqual({
      file: path.join(dir, 'services', 'kettu.service'),
      log: null,
      warning: null,
    })
    expect(await readFile(installed.file, 'utf8')).toBe(systemdUnit(command))
    expect(tools.calls).toEqual([
      'systemctl --user daemon-reload',
      'systemctl --user enable kettu.service',
      'systemctl --user restart kettu.service',
      'loginctl enable-linger',
    ])
  })

  it('says how to turn on linger when it cannot', async () => {
    const tools = deps('linux', { 'loginctl enable-linger': { code: 1, stderr: 'Access denied' } })
    const { warning } = await installService(tools, command, dir)
    expect(warning).toBe(
      'loginctl enable-linger failed with 1: Access denied\n' +
        'The service stops when you log out until linger is on: sudo loginctl enable-linger ada',
    )
  })

  it('stops at a systemctl that fails', async () => {
    const tools = deps('linux', {
      'systemctl --user daemon-reload': { code: 1, stderr: 'Failed to connect to bus' },
    })
    await expect(installService(tools, command, dir)).rejects.toThrow(
      'systemctl --user daemon-reload failed with 1: Failed to connect to bus',
    )
  })

  it('uninstalls by disabling and stopping the unit, leaving linger on', async () => {
    const tools = deps('linux')
    const { file } = await installService(tools, command, dir)
    tools.calls.length = 0
    expect(await uninstallService(tools)).toBe(true)
    expect(await exists(file)).toBe(false)
    expect(tools.calls).toEqual([
      'systemctl --user disable --now kettu.service',
      'systemctl --user daemon-reload',
    ])
  })

  it('reports a unit that is not installed', async () => {
    const tools = deps('linux')
    expect(await uninstallService(tools)).toBe(false)
    expect(tools.calls).toEqual([])
  })
})

describe('on macOS', () => {
  it('installs the LaunchAgent into the desktop session, replacing one already loaded', async () => {
    const tools = deps('darwin', {
      'launchctl bootout gui/501/sh.kettu.daemon': { code: 3, stderr: 'No such process' },
    })
    const data = path.join(dir, 'data')
    const installed = await installService(tools, command, data)
    const log = path.join(data, 'logs', 'daemon.log')
    expect(installed).toEqual({
      file: path.join(dir, 'services', 'sh.kettu.daemon.plist'),
      log,
      warning: null,
    })
    expect(await readFile(installed.file, 'utf8')).toBe(launchAgent(command, log))
    expect(await exists(path.dirname(log))).toBe(true)
    expect(tools.calls).toEqual([
      'launchctl print gui/501',
      'launchctl bootout gui/501/sh.kettu.daemon',
      'launchctl enable gui/501/sh.kettu.daemon',
      `launchctl bootstrap gui/501 ${installed.file}`,
    ])
  })

  it('refuses without a desktop session, which launchd runs a LaunchAgent in', async () => {
    const tools = deps('darwin', { 'launchctl print gui/501': { code: 113 } })
    await expect(installService(tools, command, dir)).rejects.toThrow(
      'launchd runs the service only while you are logged in to this Mac at its desktop',
    )
    expect(await exists(serviceFile(tools))).toBe(false)
  })

  it('uninstalls by booting the agent out and removing its file', async () => {
    const tools = deps('darwin')
    const { file } = await installService(tools, command, dir)
    tools.calls.length = 0
    expect(await uninstallService(tools)).toBe(true)
    expect(await exists(file)).toBe(false)
    expect(tools.calls).toEqual(['launchctl bootout gui/501/sh.kettu.daemon'])
  })

  it('reports an agent that is not installed', async () => {
    const tools = deps('darwin', {
      'launchctl bootout gui/501/sh.kettu.daemon': { code: 113, stderr: 'Could not find service' },
    })
    expect(await uninstallService(tools)).toBe(false)
  })
})
