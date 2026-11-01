// Entry of the `kettu` CLI under Node.js, built into out/daemon/main.cjs beside the hosts' bundles.

import { execFile, spawn } from 'node:child_process'
import { access, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { addressText } from '@shared/remote/address'
import { version } from '../../package.json'
import { AccountApi, accountBaseUrl, clientInfo } from '../main/account/service'
import { accountFile, readAccount } from '../main/account/store'
import { readJsonFile } from '../main/json-file'
import { parseSettingsFile } from '../main/settings-schema'
import { nodeSystemReleaseForRun } from '../main/system-name'
import { accountLine, login, logout } from './account'
import { HELP, parseCommand, type Command } from './args'
import {
  callControl,
  connectControl,
  ControlError,
  NotRunning,
  type ControlClient,
  type DaemonStatus,
} from './control'
import { AlreadyRunning, SERVICE_ENV, startDaemon } from './daemon'
import { changePort, directReport } from './direct'
import { NO_SYSTEM_ENCRYPTION, prepareDataFolder, privateFolder } from './key'
import { pairDevice, sshTarget } from './pair'
import { proxiedFetch } from './proxy'
import { controlSocketPath, DATA_ENV, dataPath } from './paths'
import { terminalQuestions } from './questions'
import { devicesReport, runningReport, stoppedReport, terminalReport } from './report'
import {
  installService,
  serviceCommand,
  ServiceError,
  serviceFile,
  uninstallService,
  type CommandResult,
  type ServiceDeps,
} from './service'
import { RELEASES, RELEASES_ENV, update, UpdateError } from './update'

const SUPPORTED: readonly NodeJS.Platform[] = ['darwin', 'linux']
const START_WAIT_MS = 20_000
const STOP_WAIT_MS = 15_000

/** A failure the CLI reports in a line of its own, without a stack. */
class Failure extends Error {
  constructor(
    message: string,
    readonly code = 1,
  ) {
    super(message)
  }
}

/** The exit code of a command that needs the daemon when none runs, as `kettu status` exits. */
const NOT_RUNNING = 3

const out = (text: string): void => void process.stdout.write(text)
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function runTool(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 30_000 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 127) : 0
      resolve({ code, stdout, stderr: stderr || (error && code === 127 ? error.message : '') })
    })
  })
}

/** The daemon's status, or null when it is not running. */
async function statusOf(socket: string): Promise<DaemonStatus | null> {
  try {
    return await callControl(socket, 'status', undefined)
  } catch (error) {
    if (error instanceof NotRunning) return null
    throw error
  }
}

async function pair(socket: string): Promise<number> {
  let client: ControlClient
  try {
    client = await connectControl(socket)
  } catch (error) {
    if (error instanceof NotRunning) throw new Failure('The daemon is not running')
    throw error
  }
  const stop = new AbortController()
  const abort = (): void => stop.abort()
  process.once('SIGINT', abort)
  const questions = terminalQuestions(process.stdin, process.stdout)
  try {
    const { status } = await client.call('direct.get', undefined)
    const ssh =
      status?.state === 'listening'
        ? {
            port: status.port,
            target: sshTarget(process.env, os.userInfo().username, os.hostname()),
          }
        : null
    return await pairDevice(
      client,
      { write: out, live: process.stdout.isTTY === true, ask: questions.ask },
      stop.signal,
      { ssh },
    )
  } catch (error) {
    if (error instanceof ControlError) throw new Failure(error.message)
    throw error
  } finally {
    questions.close()
    process.off('SIGINT', abort)
  }
}

/** A command of `kettu direct`, which goes through the running daemon's control socket. */
async function direct(
  socket: string,
  command: Extract<Command, { kind: 'direct' | 'direct-port' | 'direct-add' | 'direct-remove' }>,
): Promise<number> {
  try {
    switch (command.kind) {
      case 'direct':
        out(directReport(await callControl(socket, 'direct.get', undefined)))
        return 0
      case 'direct-port': {
        const client = await connectControl(socket)
        const questions = terminalQuestions(process.stdin, process.stdout)
        try {
          return await changePort(
            client,
            {
              write: out,
              error: (message) => void process.stderr.write(`kettu: ${message}\n`),
              interactive: process.stdin.isTTY === true,
              ask: (question) => questions.ask(question),
            },
            command.port,
            command.yes,
          )
        } finally {
          questions.close()
          client.close()
        }
      }
      case 'direct-add':
        await callControl(socket, 'direct.add', command.address)
        out(`Added ${addressText(command.address)}, which devices try first.\n`)
        return 0
      case 'direct-remove':
        await callControl(socket, 'direct.remove', command.address)
        out(`Removed ${addressText(command.address)}.\n`)
        return 0
    }
  } catch (error) {
    if (error instanceof NotRunning) throw new Failure(error.message, NOT_RUNNING)
    if (error instanceof ControlError) throw new Failure(error.message)
    throw error
  }
}

/** `kettu terminal`, with `on` or `off` to change it, through the running daemon. */
async function terminal(
  socket: string,
  command: Extract<Command, { kind: 'terminal' | 'terminal-set' }>,
): Promise<number> {
  try {
    const report =
      command.kind === 'terminal'
        ? await callControl(socket, 'terminal.get', undefined)
        : await callControl(socket, 'terminal.set', { allowed: command.allowed })
    out(terminalReport(report.allowed))
    return 0
  } catch (error) {
    if (error instanceof NotRunning) throw new Failure(error.message, NOT_RUNNING)
    if (error instanceof ControlError) throw new Failure(error.message)
    throw error
  }
}

/** Runs an install script with its output on this terminal, and resolves to its exit code. */
async function runInstallScript(script: string, args: string[]): Promise<number> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kettu-update-'))
  try {
    const file = path.join(dir, 'install.sh')
    await writeFile(file, script)
    return await new Promise<number>((resolve, reject) => {
      spawn('/bin/sh', [file, ...args], { stdio: 'inherit' })
        .once('error', reject)
        .once('exit', (code, signal) => resolve(code ?? (signal ? 128 : 1)))
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * `kettu ssh-setup`: what the desktop app connects with when it adds this computer over SSH, as
 * one line of JSON, once the device its request names is added. The login it came over proves the
 * device is the owner's, as pairing would.
 */
async function sshSetup(socket: string, request: string | null): Promise<number> {
  let params: unknown = {}
  if (request !== null) {
    try {
      params = JSON.parse(request)
    } catch {
      throw new Failure('The request is not JSON', 2)
    }
  }
  const started = Date.now()
  for (;;) {
    try {
      const setup = await callControl(socket, 'ssh.setup', params as { device: null })
      out(`${JSON.stringify(setup)}\n`)
      return 0
    } catch (error) {
      if (error instanceof NotRunning) throw new Failure(error.message, NOT_RUNNING)
      // A daemon the install just started may not take channels yet.
      const starting = error instanceof ControlError && error.code === 'unavailable'
      if (starting && Date.now() - started < START_WAIT_MS) {
        await delay(500)
        continue
      }
      if (error instanceof ControlError) throw new Failure(error.message)
      throw error
    }
  }
}

/** `kettu login` or `kettu logout`, which need no running daemon. */
async function account(kind: 'login' | 'logout', data: string): Promise<number> {
  let base: string
  try {
    base = accountBaseUrl(process.env)
  } catch (error) {
    throw new Failure((error as Error).message)
  }
  // Read, never written: the running daemon alone writes its settings.
  const read = await readJsonFile(path.join(data, 'settings.json'))
  const settings = parseSettingsFile(read.kind === 'ok' ? read.value : { version: 1 }).settings
  const file = accountFile(data)
  await prepareDataFolder(data)
  await privateFolder(path.dirname(file))
  const stop = new AbortController()
  const abort = (): void => stop.abort()
  process.once('SIGINT', abort)
  try {
    const deps = {
      api: new AccountApi(
        base,
        proxiedFetch(() => settings.proxy, process.env),
      ),
      file,
      cipher: NO_SYSTEM_ENCRYPTION,
      clientInfo: async () =>
        clientInfo({
          kind: 'daemon',
          name: settings.remote.name ?? os.hostname(),
          os: await nodeSystemReleaseForRun(),
          arch: process.arch,
          version,
        }),
      write: out,
      error: (message: string) => void process.stderr.write(`kettu: ${message}\n`),
      signal: stop.signal,
    }
    return await (kind === 'login' ? login(deps) : logout(deps))
  } finally {
    process.off('SIGINT', abort)
  }
}

/** The account line of `kettu status`. */
async function statusAccount(data: string): Promise<string> {
  const stored = await readAccount(accountFile(data), (message) =>
    process.stderr.write(`kettu: ${message}\n`),
  )
  return accountLine(stored)
}

async function until<T>(check: () => Promise<T | null>, ms: number): Promise<T | null> {
  const started = Date.now()
  for (;;) {
    const value = await check().catch(() => null)
    if (value !== null || Date.now() - started > ms) return value
    await delay(250)
  }
}

async function run(command: Exclude<Command, { kind: 'help' | 'version' | 'usage' }>) {
  const data = dataPath({
    platform: process.platform,
    home: os.homedir(),
    env: process.env,
    cwd: process.cwd(),
  })
  const socket = controlSocketPath(data)
  if (!socket) {
    throw new Failure(`The data folder's path is too long for a socket; set a shorter ${DATA_ENV}`)
  }
  const service: ServiceDeps = {
    platform: process.platform,
    home: os.homedir(),
    env: process.env,
    uid: os.userInfo().uid,
    run: runTool,
  }

  switch (command.kind) {
    case 'run': {
      const daemon = await startDaemon({
        dataPath: data,
        controlSocket: socket,
        version,
        bundleDir: __dirname,
        env: process.env,
      })
      await new Promise<void>((resolve) => {
        const stop = (): void => void daemon.stop().then(resolve)
        process.on('SIGTERM', stop)
        process.on('SIGINT', stop)
        process.on('SIGHUP', stop)
      })
      return 0
    }

    case 'status': {
      const status = await statusOf(socket)
      const signedIn = await statusAccount(data)
      out(status ? runningReport(status, signedIn) : stoppedReport(version, data, signedIn))
      return status ? 0 : 3
    }

    case 'devices':
    case 'devices-remove': {
      try {
        if (command.kind === 'devices') {
          out(devicesReport(await callControl(socket, 'devices.list', undefined), Date.now()))
        } else {
          await callControl(socket, 'devices.remove', { id: command.id })
          out(`Removed the device ${command.id}.\n`)
        }
        return 0
      } catch (error) {
        if (error instanceof NotRunning) throw new Failure('The daemon is not running')
        if (error instanceof ControlError) throw new Failure(error.message)
        throw error
      }
    }

    case 'pair':
      return pair(socket)

    case 'ssh-setup':
      return sshSetup(socket, command.request)

    case 'login':
    case 'logout':
      return account(command.kind, data)

    case 'direct':
    case 'direct-port':
    case 'direct-add':
    case 'direct-remove':
      return direct(socket, command)

    case 'terminal':
    case 'terminal-set':
      return terminal(socket, command)

    case 'service-install': {
      const running = await statusOf(socket)
      if (running && !running.service) {
        throw new Failure(
          `A Kettu daemon runs in the foreground on this data folder (pid ${running.pid}); ` +
            'stop it before installing the service',
        )
      }
      await prepareDataFolder(data)
      const script = await realpath(process.argv[1]!)
      const installed = await installService(
        service,
        serviceCommand(process.execPath, script, process.env, SERVICE_ENV),
        data,
      )
      const started = await until(async () => {
        const status = await statusOf(socket)
        return status && !status.stopping && status.pid !== running?.pid ? status : null
      }, START_WAIT_MS)
      const logs = installed.log ?? 'journalctl --user -u kettu'
      if (!started) {
        throw new Failure(`Installed ${installed.file}, but the daemon did not start; see ${logs}`)
      }
      out(
        `Installed ${installed.file}\nThe daemon is running (pid ${started.pid}); its log: ${logs}\n`,
      )
      if (installed.warning) {
        process.stderr.write(`kettu: ${installed.warning}\n`)
        return 1
      }
      return 0
    }

    case 'service-uninstall': {
      if (!(await uninstallService(service))) {
        out('The service is not installed.\n')
        return 0
      }
      const stopped = await until(async () => {
        const status = await statusOf(socket)
        return status?.service ? null : true
      }, STOP_WAIT_MS)
      if (!stopped) throw new Failure('Removed the service, but its daemon is still running')
      out('Removed the service; its daemon has stopped.\n')
      return 0
    }

    case 'update': {
      const running = await statusOf(socket)
      return update({
        version,
        bundleDir: __dirname,
        releases: process.env[RELEASES_ENV]?.trim() || RELEASES,
        fetch,
        service: await access(serviceFile(service)).then(
          () => true,
          () => false,
        ),
        foreground: running !== null && !running.service,
        install: runInstallScript,
        write: out,
      })
    }
  }
}

async function main(argv: string[]): Promise<number> {
  const command = parseCommand(argv)
  if (command.kind === 'help') {
    out(HELP)
    return 0
  }
  if (command.kind === 'version') {
    out(`${version}\n`)
    return 0
  }
  if (command.kind === 'usage') {
    process.stderr.write(`kettu: ${command.message}. Run kettu --help for usage.\n`)
    return 2
  }
  if (!SUPPORTED.includes(process.platform)) {
    process.stderr.write('kettu: the daemon runs on macOS and Linux\n')
    return 1
  }
  try {
    return await run(command)
  } catch (error) {
    const known =
      error instanceof Failure ||
      error instanceof AlreadyRunning ||
      error instanceof ServiceError ||
      error instanceof UpdateError
    process.stderr.write(
      `kettu: ${known ? (error as Error).message : ((error as Error)?.stack ?? String(error))}\n`,
    )
    return error instanceof Failure ? error.code : 1
  }
}

void main(process.argv.slice(2)).then((code) => {
  process.exitCode = code
  // Whatever still holds the event loop, such as a host that would not die, does not hold the exit.
  setTimeout(() => process.exit(code), 2000).unref()
})
