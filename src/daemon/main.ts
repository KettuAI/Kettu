// Entry of the `kettu` CLI under Node.js, built into out/daemon/main.cjs beside the hosts' bundles.

import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import os from 'node:os'
import { createInterface } from 'node:readline'
import { addressText } from '@shared/remote/address'
import { version } from '../../package.json'
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
import { prepareDataFolder } from './key'
import { pairDevice } from './pair'
import { controlSocketPath, DATA_ENV, dataPath } from './paths'
import { devicesReport, runningReport, stoppedReport } from './report'
import {
  installService,
  serviceCommand,
  ServiceError,
  uninstallService,
  type CommandResult,
  type ServiceDeps,
} from './service'

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

/** A question on the terminal with `initial` typed for the owner to edit; null once input ends. */
function ask(question: string, initial?: string): Promise<string | null> {
  // Typed ahead only on a terminal; piped input would be read after it on the same line.
  const typed = process.stdin.isTTY === true
  const lines = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise<string | null>((resolve) => {
    lines.once('close', () => resolve(null))
    lines.once('SIGINT', () => lines.close())
    lines.question(initial && !typed ? `${question}[${initial}] ` : question, (answer) => {
      resolve(answer)
      lines.close()
    })
    if (initial && typed) lines.write(initial)
  })
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
  try {
    return await pairDevice(
      client,
      { write: out, live: process.stdout.isTTY === true, ask },
      stop.signal,
    )
  } catch (error) {
    if (error instanceof ControlError) throw new Failure(error.message)
    throw error
  } finally {
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
        try {
          return await changePort(
            client,
            {
              write: out,
              error: (message) => void process.stderr.write(`kettu: ${message}\n`),
              interactive: process.stdin.isTTY === true,
              ask: (question) => ask(question),
            },
            command.port,
            command.yes,
          )
        } finally {
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
      out(status ? runningReport(status) : stoppedReport(version, data))
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

    case 'direct':
    case 'direct-port':
    case 'direct-add':
    case 'direct-remove':
      return direct(socket, command)

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
      error instanceof Failure || error instanceof AlreadyRunning || error instanceof ServiceError
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
