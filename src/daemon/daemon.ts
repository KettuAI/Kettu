// `kettu run`: what main does in the desktop app, without windows. It holds the control socket,
// the host's key and the settings, starts the hosts and stops them in order.

import { chmod, rm } from 'node:fs/promises'
import { matchLocale } from '@shared/locale'
import { createLogger } from '../main/log'
import { SettingsStore } from '../main/settings'
import {
  callControl,
  ControlError,
  NotRunning,
  serveControl,
  type ControlHandlers,
  type ControlServer,
  type DaemonStatus,
} from './control'
import { isUnavailable, type HostTimings } from './forked-host'
import { Hosts } from './hosts'
import { keyIsPrivate, loadHostKey, prepareDataFolder } from './key'
import { keyPath } from './paths'

const log = createLogger('daemon')

/** Set in the service's environment, so the daemon can say it runs as one. */
export const SERVICE_ENV = 'KETTU_DAEMON_SERVICE'

export interface DaemonOptions {
  dataPath: string
  controlSocket: string
  version: string
  bundleDir: string
  env: NodeJS.ProcessEnv
  timings?: HostTimings
}

/** Something already listens on the data folder's control socket. */
export class AlreadyRunning extends Error {
  constructor(readonly pid: number | null) {
    super(
      pid === null
        ? 'Something already listens on the control socket'
        : `A Kettu daemon is already running on this data folder (pid ${pid})`,
    )
    this.name = 'AlreadyRunning'
  }
}

export interface RunningDaemon {
  /** Stops the hosts, then lets the control socket go; the same promise for every call. */
  stop(): Promise<void>
}

/** Listens on the control socket, the lock on the data folder, unless a daemon answers on it. */
async function claimControlSocket(
  socketPath: string,
  serve: () => Promise<ControlServer>,
): Promise<ControlServer> {
  let pid: number | null = null
  try {
    pid = (await callControl(socketPath, 'status', undefined, 5000)).pid
  } catch (error) {
    // Anything else listens but does not answer as a daemon would, so it is left alone.
    if (!(error instanceof NotRunning)) throw new AlreadyRunning(null)
  }
  if (pid !== null) throw new AlreadyRunning(pid)
  // Left by a daemon that was killed.
  await rm(socketPath, { force: true })
  try {
    return await serve()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new AlreadyRunning(null)
    throw error
  }
}

export async function startDaemon(options: DaemonOptions): Promise<RunningDaemon> {
  const startedAt = Date.now()
  await prepareDataFolder(options.dataPath)
  let stopping = false
  let hosts: Hosts | null = null

  const unavailable = (): never => {
    throw new ControlError('unavailable', 'Remote access is not running')
  }
  const handlers: ControlHandlers = {
    status: async () => status(),
    'host.socket': async ({ host }) => {
      if (!hosts) throw new ControlError('unavailable', 'The daemon is starting')
      try {
        return { path: await hosts.socket(host) }
      } catch (error) {
        if (!isUnavailable(error)) throw error
        throw new ControlError('unavailable', `The ${host} host is ${error.message}`)
      }
    },
    'devices.list': async () => unavailable(),
    'devices.remove': async () => unavailable(),
  }
  const server = await claimControlSocket(options.controlSocket, () =>
    serveControl(options.controlSocket, handlers, (message) => log.warn(message)),
  )

  let settings: SettingsStore
  try {
    await chmod(options.controlSocket, 0o600)
    await loadHostKey(options.dataPath, (message) => log.warn(message))
    settings = await SettingsStore.load(options.dataPath)
  } catch (error) {
    await release(server, options.controlSocket)
    throw error
  }

  // The marker stays with the daemon, so a `kettu run` in a shell an agent or terminal starts is
  // not taken for the service.
  const hostEnv = { ...options.env }
  delete hostEnv[SERVICE_ENV]
  const running = new Hosts({
    bundleDir: options.bundleDir,
    dataPath: options.dataPath,
    version: options.version,
    systemLocale: matchLocale([Intl.DateTimeFormat().resolvedOptions().locale]),
    settings: () => settings.get(),
    env: hostEnv,
    timings: options.timings,
  })
  hosts = running
  running.start()
  log.info(
    `Kettu daemon ${options.version} running (pid ${process.pid}), data in ${options.dataPath}`,
  )

  // Asked for as soon as the socket listens, before the key and the hosts exist.
  async function status(): Promise<DaemonStatus> {
    const keyFile = keyPath(options.dataPath)
    const notStarted = { state: 'idle', pid: null, restarts: 0 } as const
    return {
      version: options.version,
      pid: process.pid,
      startedAt,
      stopping,
      dataPath: options.dataPath,
      service: options.env[SERVICE_ENV] === '1',
      key: { storage: 'file', path: keyFile, private: await keyIsPrivate(keyFile) },
      hosts: hosts?.status() ?? { agent: notStarted, terminal: notStarted },
      connectedDevices: null,
    }
  }

  let stopped: Promise<void> | null = null
  return {
    stop: () => {
      stopped ??= (async () => {
        stopping = true
        log.info('Stopping')
        await running.stop()
        await settings.flush()
        // Held until now, so a daemon that starts meanwhile cannot run hosts beside these.
        await release(server, options.controlSocket)
        log.info('Stopped')
      })()
      return stopped
    },
  }
}

async function release(server: ControlServer, socketPath: string): Promise<void> {
  await server.close()
  await rm(socketPath, { force: true })
}
