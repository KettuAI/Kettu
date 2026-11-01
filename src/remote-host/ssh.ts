// Reaching a machine through the system's own ssh, with the user's config and agent, so Kettu
// never reads or keeps a key. Short scripts run in `sh -s` there to install the daemon and record
// this computer's key on it, and each channel is `ssh -W` to the port the daemon takes channels
// on, on that machine's loopback alone.

import { spawn } from 'node:child_process'
import { Duplex } from 'node:stream'
import { MAX_FAILURE_DETAIL } from '@shared/remote/hosts'
import type { Platform } from '@shared/platform'
import type { DirectAddress } from '@shared/remote/protocol'
import type { Transport } from '@shared/remote/transport'
import installScript from '../../tools/daemon/install.sh?raw'
import { quotePosix } from '../agent-host/quote'
import { RELEASES_ENV } from '../daemon/update'
import { CLOSE_GRACE_MS } from './limits'
import { streamTransport } from './stream-transport'

/** The program run as ssh, and arguments before Kettu's own; tests run a fake one with node. */
export interface SshProgram {
  command: string
  args: string[]
  env?: NodeJS.ProcessEnv
}

export const SYSTEM_SSH: SshProgram = { command: 'ssh', args: [] }

/** Where the daemon takes channels from SSH: its loopback, which only that machine reaches. */
export const SSH_LOOPBACK = '127.0.0.1'

/**
 * Before the user's config, which these override: no prompt, as nobody could answer one; no agent
 * or X11 forwarding and none of the config's port forwards, which nothing here needs; no
 * RemoteCommand, which the scripts and -W replace; and INFO, so a refused forward says why.
 */
const OPTIONS = [
  '-T',
  '-a',
  '-x',
  ...['-o', 'BatchMode=yes'],
  ...['-o', 'ConnectTimeout=15'],
  ...['-o', 'ServerAliveInterval=15'],
  ...['-o', 'ServerAliveCountMax=3'],
  ...['-o', 'ClearAllForwardings=yes'],
  ...['-o', 'RemoteCommand=none'],
  ...['-o', 'LogLevel=INFO'],
]

/** What kept ssh from a machine, from what it printed. */
export type SshProblem =
  | 'missing'
  | 'unreachable'
  | 'auth'
  | 'host_unknown'
  | 'host_changed'
  /** The server does not forward connections. */
  | 'forwarding'
  /** Nothing took the forwarded connection on that machine. */
  | 'refused'

const PROBLEMS: [RegExp, SshProblem][] = [
  [/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key for .+ has changed/, 'host_changed'],
  [/Host key verification failed|No \S+ host key is known for/, 'host_unknown'],
  [/administratively prohibited/, 'forwarding'],
  [/open failed|stdio forwarding failed/, 'refused'],
  [/Permission denied|Too many authentication failures|No more authentication methods/, 'auth'],
  [
    /Could not resolve hostname|connect to host|Connection refused|timed out|No route to host|Network is unreachable|Connection closed by|Connection reset|kex_exchange_identification|banner exchange/i,
    'unreachable',
  ],
]

/** Why ssh failed, from its own messages; null when they say nothing known. */
export function sshProblem(stderr: string): SshProblem | null {
  return PROBLEMS.find(([pattern]) => pattern.test(stderr))?.[1] ?? null
}

/** The end of some output, at most `count` lines that hold something and the detail's length. */
export function lastLines(text: string, count = 15): string {
  const lines = text
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
  return lines.slice(-count).join('\n').slice(-MAX_FAILURE_DETAIL)
}

/** How long a script may run: setting up is quick, installing downloads the package. */
export const SETUP_TIMEOUT_MS = 60_000
export const INSTALL_TIMEOUT_MS = 10 * 60_000

/** Output kept of a script's run, from the end. */
const MAX_OUTPUT = 256 * 1024

/** How long output may go on after ssh exited. */
const OUTPUT_WAIT_MS = 1_000

export interface SshRun {
  /** The exit code; 255 is ssh's own failure, null when it was killed. */
  code: number | null
  stdout: string
  stderr: string
  /** Why ssh itself failed, or null when it did not or said nothing known. */
  problem: SshProblem | null
}

const keepEnd = (kept: string, chunk: string): string => {
  const next = kept + chunk
  return next.length > MAX_OUTPUT ? next.slice(-MAX_OUTPUT) : next
}

/**
 * Runs `script` in `sh -s` on the machine, which the user's shell starts whatever it is. Settles
 * once ssh exits, is killed for taking too long, or `signal` aborts; null when it was aborted.
 */
export function runSsh(
  program: SshProgram,
  target: string,
  script: string,
  options: { timeoutMs: number; signal: AbortSignal },
): Promise<SshRun | null> {
  return new Promise((resolve) => {
    if (options.signal.aborted) return resolve(null)
    const child = spawn(program.command, [...program.args, ...OPTIONS, '--', target, 'sh -s'], {
      env: program.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let done = false
    const finish = (run: SshRun | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      options.signal.removeEventListener('abort', abort)
      resolve(run)
    }
    const abort = (): void => {
      child.kill()
      finish(null)
    }
    const timer = setTimeout(() => {
      child.kill()
      stderr += '\nssh: the command took too long and was stopped\n'
    }, options.timeoutMs)
    options.signal.addEventListener('abort', abort, { once: true })
    child.stdout
      .setEncoding('utf8')
      .on('data', (chunk: string) => (stdout = keepEnd(stdout, chunk)))
    child.stderr
      .setEncoding('utf8')
      .on('data', (chunk: string) => (stderr = keepEnd(stderr, chunk)))
    // ssh that exits before reading all of the script breaks the pipe; its exit says why.
    child.stdin.on('error', () => {})
    child.once('error', (error: NodeJS.ErrnoException) => {
      const missing = error.code === 'ENOENT'
      finish({ code: null, stdout, stderr: error.message, problem: missing ? 'missing' : null })
    })
    const exited = (code: number | null): void =>
      finish({ code, stdout, stderr, problem: code === 255 ? sshProblem(stderr) : null })
    child.once('close', exited)
    // A process ssh leaves behind, as a ControlPersist master, may hold its output open.
    child.once('exit', (code) => setTimeout(() => exited(code), OUTPUT_WAIT_MS).unref())
    child.stdin.end(script)
  })
}

/** What a device sends to `kettu ssh-setup` to be recorded, as pairing would add it. */
export interface SshDevice {
  publicKey: string
  name: string
  kind: string
  platform: string
  model: string
}

/** What `kettu ssh-setup` prints of the host. */
export interface SshHostInfo {
  /** Its X25519 public key, in base64. */
  publicKey: string
  name: string
  platform: Platform
  version: string
  /** The port it takes channels on, on its loopback. */
  port: number
}

export interface SshSetupReport {
  /** `uname -s` and `uname -m`, or null when the machine runs no POSIX shell. */
  system: { os: string; arch: string } | null
  /** The daemon's version, or null when none is installed. */
  version: string | null
  host: SshHostInfo | null
  /** How `kettu ssh-setup` exited when it failed. */
  failed: number | null
}

const MARK = 'kettu-ssh'

/**
 * Says the machine's system and the daemon's version, if one is installed, and runs its
 * `kettu ssh-setup`, which records `device` when there is one and prints the host. The link the
 * install script makes is tried first, since a shell started over SSH may not have it on its PATH.
 */
export function setupScript(device: SshDevice | null): string {
  const request = quotePosix(JSON.stringify(device ? { device } : {}))
  return [
    `printf '${MARK} system %s %s\\n' "$(uname -s 2>/dev/null)" "$(uname -m 2>/dev/null)"`,
    'kettu=$HOME/.local/bin/kettu',
    `[ -x "$kettu" ] || kettu=$(command -v kettu 2>/dev/null) || kettu=''`,
    'if [ -n "$kettu" ]; then',
    `  printf '${MARK} version %s\\n' "$("$kettu" --version 2>/dev/null | head -n 1)"`,
    `  if host=$("$kettu" ssh-setup ${request}); then`,
    `    printf '${MARK} host %s\\n' "$host"`,
    '  else',
    `    printf '${MARK} exit %s\\n' "$?"`,
    '  fi',
    'fi',
    '',
  ].join('\n')
}

const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?$/

function parseHostInfo(text: string): SshHostInfo | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const { publicKey, name, platform, version, port } = value as Record<string, unknown>
  const isText = (item: unknown): item is string =>
    typeof item === 'string' && item.length > 0 && item.length <= 256
  if (!isText(publicKey) || !isText(name) || !isText(platform) || !isText(version)) return null
  if (!Number.isSafeInteger(port) || (port as number) < 1 || (port as number) > 65535) return null
  return { publicKey, name, platform: platform as Platform, version, port: port as number }
}

/** What the setup script printed. */
export function parseSetupReport(stdout: string): SshSetupReport {
  const report: SshSetupReport = { system: null, version: null, host: null, failed: null }
  for (const line of stdout.replace(/\r/g, '').split('\n')) {
    if (!line.startsWith(`${MARK} `)) continue
    const [, field, ...rest] = line.split(' ')
    const value = rest.join(' ').trim()
    if (field === 'system') {
      const [os = '', arch = ''] = rest
      report.system = { os, arch }
    } else if (field === 'version') {
      report.version = VERSION.test(value) ? value : null
    } else if (field === 'host') {
      report.host = parseHostInfo(value)
    } else if (field === 'exit') {
      report.failed = Number.parseInt(value, 10)
    }
  }
  return report
}

/**
 * `uname -s` and `uname -m` the daemon has no package for, as "FreeBSD amd64"; null for Linux and
 * macOS on x64 and arm64, which the install script checks further, as for glibc or Rosetta.
 */
export function unsupportedSystem(system: SshSetupReport['system']): string | null {
  if (!system) return null
  const supported =
    (system.os === 'Linux' || system.os === 'Darwin') &&
    ['x86_64', 'amd64', 'aarch64', 'arm64'].includes(system.arch)
  return supported ? null : `${system.os} ${system.arch}`.trim()
}

/**
 * The release's install script for `version`, with its output on one stream so its last lines
 * read in order, and the download place of `KETTU_RELEASES_URL` when this computer names one.
 */
export function installRun(version: string, env: NodeJS.ProcessEnv = process.env): string {
  const releases = env[RELEASES_ENV]?.trim()
  return [
    'exec 2>&1',
    `set -- --version ${quotePosix(version)}`,
    ...(releases ? [`${RELEASES_ENV}=${quotePosix(releases)}`, `export ${RELEASES_ENV}`] : []),
    installScript,
  ].join('\n')
}

/**
 * Each connection to the daemon through `ssh -W`, one ssh each, and why the last one ended when
 * ssh failed.
 */
export class SshForward {
  private stderr = ''
  private exitCode: number | null = null

  constructor(
    private readonly program: SshProgram,
    private readonly target: string,
  ) {}

  /** Why the last ssh failed, or null while it runs or when it said nothing known. */
  problem(): SshProblem | null {
    if (this.exitCode === -1) return 'missing'
    return this.exitCode === 255 ? sshProblem(this.stderr) : null
  }

  /** The end of what the last ssh said. */
  detail(): string {
    return lastLines(this.stderr)
  }

  /** Starts ssh; the transport is its standard input and output, closed once ssh exits. */
  readonly connect = (address: DirectAddress, signal: AbortSignal): Promise<Transport> =>
    new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason)
      this.stderr = ''
      this.exitCode = null
      const forward = `${address.host}:${address.port}`
      const child = spawn(
        this.program.command,
        [...this.program.args, ...OPTIONS, '-W', forward, '--', this.target],
        {
          env: this.program.env ?? process.env,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        },
      )
      const abort = (): void => {
        child.kill()
        reject(signal.reason)
      }
      signal.addEventListener('abort', abort, { once: true })
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        this.stderr = keepEnd(this.stderr, chunk).slice(-MAX_FAILURE_DETAIL * 4)
      })
      child.once('error', (error: NodeJS.ErrnoException) => {
        signal.removeEventListener('abort', abort)
        if (error.code === 'ENOENT') this.exitCode = -1
        reject(error)
      })
      child.once('exit', (code) => (this.exitCode = code))
      child.once('spawn', () => {
        signal.removeEventListener('abort', abort)
        const stream = Duplex.from({ readable: child.stdout, writable: child.stdin })
        // The transport ends with ssh, whichever side it was that ended the connection.
        child.once('close', () => stream.destroy())
        const transport = streamTransport(stream)
        resolve({
          ...transport,
          close: () => {
            // The end of its input closes the forward; ssh that lingers is stopped.
            transport.close()
            setTimeout(() => child.kill(), CLOSE_GRACE_MS).unref()
          },
        })
      })
    })
}
