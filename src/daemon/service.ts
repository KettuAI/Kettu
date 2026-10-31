// `kettu service`: the daemon as a systemd user unit with linger on Linux, so it runs from boot and
// after the user logs out, or as a LaunchAgent on macOS. Either one runs `kettu run` and starts it
// again whenever it exits.

import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { DATA_ENV, logPath } from './paths'

export const LAUNCH_AGENT_LABEL = 'sh.kettu.daemon'
export const SYSTEMD_UNIT = 'kettu.service'

// launchd kills an agent 5 s after SIGTERM unless told otherwise; the daemon may take 6 s for a
// host to stop and 2 s more to kill it, then lets the control socket go.
const EXIT_TIMEOUT_S = 20

/** The command line the service runs, and the variables it sets. */
export interface ServiceCommand {
  program: string
  args: string[]
  env: Record<string, string>
}

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

export interface ServiceDeps {
  platform: NodeJS.Platform
  home: string
  env: NodeJS.ProcessEnv
  uid: number
  /** Runs a system tool, such as systemctl or launchctl, and never throws for its exit code. */
  run(command: string, args: string[]): Promise<CommandResult>
  /** Where the service file goes, when a test names a folder of its own. */
  dir?: string
}

export class ServiceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ServiceError'
  }
}

/** The service's command: the program running this CLI, `run`, and the data folder it uses. */
export function serviceCommand(
  program: string,
  script: string,
  env: NodeJS.ProcessEnv,
  serviceEnv: string,
): ServiceCommand {
  const variables: Record<string, string> = { [serviceEnv]: '1' }
  const data = env[DATA_ENV]?.trim()
  if (data) variables[DATA_ENV] = path.resolve(data)
  return { program, args: [script, 'run'], env: variables }
}

function serviceDir(deps: ServiceDeps): string {
  if (deps.dir) return deps.dir
  if (deps.platform === 'darwin') return path.join(deps.home, 'Library', 'LaunchAgents')
  const config = deps.env.XDG_CONFIG_HOME?.trim()
  const base = config && path.isAbsolute(config) ? config : path.join(deps.home, '.config')
  return path.join(base, 'systemd', 'user')
}

export function serviceFile(deps: ServiceDeps): string {
  const name = deps.platform === 'darwin' ? `${LAUNCH_AGENT_LABEL}.plist` : SYSTEMD_UNIT
  return path.join(serviceDir(deps), name)
}

// systemd reads `%` as a specifier and `$` as a variable even inside quotes.
function systemdWord(value: string): string {
  const escaped = value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('%', '%%')
    .replaceAll('$', '$$$$')
  return `"${escaped}"`
}

export function systemdUnit(command: ServiceCommand): string {
  const exec = [command.program, ...command.args].map(systemdWord).join(' ')
  const env = Object.entries(command.env)
    .map(([name, value]) => systemdWord(`${name}=${value}`))
    .join(' ')
  return `[Unit]
Description=Kettu daemon
Documentation=https://github.com/KettuAI/Kettu

[Service]
Type=simple
ExecStart=${exec}
Environment=${env}
Restart=always
RestartSec=2
# SIGTERM to the daemon alone, which stops its hosts in order; SIGKILL to what is left at the end.
KillMode=mixed

[Install]
WantedBy=default.target
`
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export function launchAgent(command: ServiceCommand, log: string): string {
  const args = [command.program, ...command.args]
    .map((arg) => `\t\t<string>${xml(arg)}</string>`)
    .join('\n')
  const env = Object.entries(command.env)
    .map(([name, value]) => `\t\t<key>${xml(name)}</key>\n\t\t<string>${xml(value)}</string>`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${LAUNCH_AGENT_LABEL}</string>
\t<key>ProgramArguments</key>
\t<array>
${args}
\t</array>
\t<key>EnvironmentVariables</key>
\t<dict>
${env}
\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<true/>
\t<key>ExitTimeOut</key>
\t<integer>${EXIT_TIMEOUT_S}</integer>
\t<key>StandardOutPath</key>
\t<string>${xml(log)}</string>
\t<key>StandardErrorPath</key>
\t<string>${xml(log)}</string>
</dict>
</plist>
`
}

function failure(what: string, result: CommandResult): ServiceError {
  const output = (result.stderr || result.stdout).trim()
  return new ServiceError(`${what} failed with ${result.code}${output ? `: ${output}` : ''}`)
}

async function must(deps: ServiceDeps, command: string, args: string[]): Promise<void> {
  const result = await deps.run(command, args)
  if (result.code !== 0) throw failure(`${command} ${args.join(' ')}`, result)
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export interface Installed {
  file: string
  /** Where the daemon's output goes; journald's on Linux. */
  log: string | null
  /** Why the service may stop when the user logs out, if it may. */
  warning: string | null
}

/** Writes the service file and starts the service, replacing one already there. */
export async function installService(
  deps: ServiceDeps,
  command: ServiceCommand,
  dataPath: string,
): Promise<Installed> {
  const file = serviceFile(deps)
  if (deps.platform === 'darwin') {
    const domain = `gui/${deps.uid}`
    // launchd runs a LaunchAgent in a desktop session; over SSH alone there is none to join.
    if ((await deps.run('launchctl', ['print', domain])).code !== 0) {
      throw new ServiceError(
        'launchd runs the service only while you are logged in to this Mac at its desktop. ' +
          'Log in there, or turn on automatic login, and run this again.',
      )
    }
    const log = logPath(dataPath)
    await mkdir(path.dirname(log), { recursive: true, mode: 0o700 })
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, launchAgent(command, log))
    const target = `${domain}/${LAUNCH_AGENT_LABEL}`
    // A service already running stops first, so it starts from the file just written.
    await deps.run('launchctl', ['bootout', target])
    await must(deps, 'launchctl', ['enable', target])
    // bootout can return before the old process is gone, which fails bootstrap for a moment.
    let result = await deps.run('launchctl', ['bootstrap', domain, file])
    for (let attempt = 1; result.code !== 0 && attempt < 5; attempt++) {
      await delay(attempt * 500)
      result = await deps.run('launchctl', ['bootstrap', domain, file])
    }
    if (result.code !== 0) throw failure(`launchctl bootstrap ${domain} ${file}`, result)
    return { file, log, warning: null }
  }

  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, systemdUnit(command))
  await must(deps, 'systemctl', ['--user', 'daemon-reload'])
  await must(deps, 'systemctl', ['--user', 'enable', SYSTEMD_UNIT])
  await must(deps, 'systemctl', ['--user', 'restart', SYSTEMD_UNIT])
  // Without linger, systemd stops the user's services when their last session ends.
  const linger = await deps.run('loginctl', ['enable-linger'])
  const user = deps.env.USER || deps.env.LOGNAME || '$USER'
  return {
    file,
    log: null,
    warning:
      linger.code === 0
        ? null
        : `${failure('loginctl enable-linger', linger).message}\n` +
          'The service stops when you log out until linger is on: ' +
          `sudo loginctl enable-linger ${user}`,
  }
}

/** Stops the service and removes its file; false when it was not installed. */
export async function uninstallService(deps: ServiceDeps): Promise<boolean> {
  const file = serviceFile(deps)
  const installed = await exists(file)
  if (deps.platform === 'darwin') {
    const result = await deps.run('launchctl', ['bootout', `gui/${deps.uid}/${LAUNCH_AGENT_LABEL}`])
    // 3 and 113 mean no such service is loaded.
    if (result.code !== 0 && result.code !== 3 && result.code !== 113 && installed) {
      throw failure(`launchctl bootout gui/${deps.uid}/${LAUNCH_AGENT_LABEL}`, result)
    }
    await rm(file, { force: true })
    return installed
  }
  if (!installed) return false
  // Linger stays on: other services of the user may need it.
  const result = await deps.run('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT])
  if (result.code !== 0) throw failure(`systemctl --user disable --now ${SYSTEMD_UNIT}`, result)
  await rm(file, { force: true })
  await must(deps, 'systemctl', ['--user', 'daemon-reload'])
  return true
}
