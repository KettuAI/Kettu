// `kettu run`: what main does in the desktop app, without windows. It holds the control socket,
// the host's key and the settings, starts the hosts and stops them in order. It alone writes the
// settings, so a change from the CLI comes through the control socket and applies at once.

import { chmod, rm } from 'node:fs/promises'
import os from 'node:os'
import { matchLocale } from '@shared/locale'
import { addressKey, MAX_OWN_ADDRESSES } from '@shared/remote/address'
import { createLogger } from '../main/log'
import type { RemoteIdentity } from '../main/remote-identity'
import { SettingsStore } from '../main/settings'
import { SettingsError } from '../main/settings-schema'
import {
  callControl,
  ControlError,
  NotRunning,
  serveControl,
  type ControlConnection,
  type ControlHandlers,
  type ControlServer,
  type DaemonStatus,
  type DirectReport,
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

  const starting = (): Hosts => {
    if (!hosts) throw new ControlError('unavailable', 'The daemon is starting')
    return hosts
  }
  // Only the connection that opened a code may answer for it.
  const codeOwners = new Map<number, ControlConnection>()
  const handlers: ControlHandlers = {
    status: async () => status(),
    'host.socket': async ({ host }) => {
      try {
        return { path: await starting().socket(host) }
      } catch (error) {
        if (!isUnavailable(error)) throw error
        throw new ControlError('unavailable', `The ${host} host is ${error.message}`)
      }
    },
    'devices.list': async () => starting().devices(),
    'devices.remove': async ({ id }) => {
      await starting().removeDevice(id)
      return null
    },
    'pair.open': async (_, connection) => {
      const running = starting()
      let codeId = 0
      codeId = running.pair((pairing) => {
        if (pairing.state === 'added' || pairing.state === 'void') codeOwners.delete(codeId)
        connection.notify({ type: 'pairing', codeId, pairing })
      })
      codeOwners.set(codeId, connection)
      connection.onClose(() => {
        codeOwners.delete(codeId)
        running.closePairing(codeId)
      })
      return { codeId }
    },
    'pair.answer': async ({ codeId, add, name }, connection) => {
      if (codeOwners.get(codeId) !== connection) {
        throw new ControlError('not_found', 'This connection opened no such code')
      }
      starting().answerPairing(codeId, add, name)
      return null
    },
    'direct.get': async () => {
      starting()
      return directReport()
    },
    'direct.port': async ({ port }) => {
      const running = starting()
      const before = running.directStatus()
      if (port !== settings.get().remote.direct.port) {
        changeSettings({ remote: { direct: { port } } })
      } else if (before?.state === 'listening') {
        return directReport()
      } else {
        running.retryDirect()
      }
      await running.directSettled(before)
      return directReport()
    },
    'direct.add': async (address) => {
      starting()
      const own = settings.get().remote.direct.addresses
      if (own.some((kept) => addressKey(kept) === addressKey(address))) {
        throw new ControlError('invalid_params', 'This address is already in the list')
      }
      if (own.length >= MAX_OWN_ADDRESSES) {
        throw new ControlError('invalid_params', `You can add up to ${MAX_OWN_ADDRESSES} addresses`)
      }
      changeSettings({ remote: { direct: { addresses: [...own, address] } } })
      return directReport()
    },
    'direct.remove': async (address) => {
      starting()
      const own = settings.get().remote.direct.addresses
      const kept = own.filter((entry) => addressKey(entry) !== addressKey(address))
      if (kept.length === own.length) {
        throw new ControlError('not_found', 'This address is not in the list')
      }
      changeSettings({ remote: { direct: { addresses: kept } } })
      return directReport()
    },
  }
  const server = await claimControlSocket(options.controlSocket, () =>
    serveControl(options.controlSocket, handlers, (message) => log.warn(message)),
  )

  let settings: SettingsStore
  let identity: RemoteIdentity
  try {
    await chmod(options.controlSocket, 0o600)
    identity = await loadHostKey(options.dataPath, (message) => log.warn(message))
    settings = await SettingsStore.load(options.dataPath)
    // Without the relay devices reach the daemon only directly, as the app without it; turning
    // them on the first time picks their port.
    if (!settings.get().remote.direct.enabled) {
      settings.update({ remote: { direct: { enabled: true } } })
    }
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
    privateKey: identity.privateKey,
    hostName: os.hostname(),
    env: hostEnv,
    timings: options.timings,
  })
  hosts = running
  settings.onChange((_, changed) => {
    if (changed.has('remote')) running.directChanged()
  })
  running.start()
  log.info(
    `Kettu daemon ${options.version} running (pid ${process.pid}), data in ${options.dataPath}`,
  )

  // Asked for as soon as the socket listens, before the key and the hosts exist.
  async function status(): Promise<DaemonStatus> {
    const keyFile = keyPath(options.dataPath)
    const idle = { state: 'idle', pid: null, restarts: 0 } as const
    return {
      version: options.version,
      pid: process.pid,
      startedAt,
      stopping,
      dataPath: options.dataPath,
      service: options.env[SERVICE_ENV] === '1',
      key: { storage: 'file', path: keyFile, private: await keyIsPrivate(keyFile) },
      hosts: hosts?.status() ?? { agent: idle, terminal: idle, remote: idle },
      connectedDevices: hosts?.connectedDevices() ?? null,
      direct: hosts?.directStatus() ?? null,
    }
  }

  function directReport(): DirectReport {
    const { port, addresses } = settings.get().remote.direct
    return { port, own: addresses, status: starting().directStatus() }
  }

  /** Applies a change to the settings, refused with the store's reason when it is not valid. */
  function changeSettings(patch: unknown): void {
    try {
      settings.update(patch)
    } catch (error) {
      if (error instanceof SettingsError) throw new ControlError('invalid_params', error.message)
      throw error
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
