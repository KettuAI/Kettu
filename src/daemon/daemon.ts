// `kettu run`: what main does in the desktop app, without windows. It holds the control socket,
// the host's key and the settings, starts the hosts and stops them in order. It alone writes the
// settings, so a change from the CLI comes through the control socket and applies at once.

import { bundleForDevice, ReportShelf } from '@shared/log/report-bundle'
import { chmod, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DEBUG_PORTS_FILE } from '@shared/debug'
import {
  DebugPortsFile,
  INSPECT_ENV,
  openInspector,
  removePortsFile,
} from '@shared/log/debug-inspector'
import {
  logEnvironment,
  logFolder,
  setLogLevel,
  setVerboseRecords,
  verboseRecords,
} from '@shared/log/process-log'
import { matchLocale } from '@shared/locale'
import { addressKey, MAX_OWN_ADDRESSES } from '@shared/remote/address'
import { PUSH_URL, PUSH_URL_ENV, pushUrlFrom } from '@shared/remote/push'
import { RELAY_URL, RELAY_URL_ENV, relayUrlFrom } from '@shared/remote/relay'
import type { HostAdmin } from '../main/host-admin'
import { Account } from '../main/account'
import { accountBaseUrl, AccountApi, clientInfo, DAEMON_CLIENT } from '../main/account/service'
import { accountFile } from '../main/account/store'
import { createLogger } from '../main/log'
import { MarketKeys, marketKeysFile } from '../main/market-keys'
import { RelayToken } from '../main/relay-token'
import { nodeSystemReleaseForRun } from '../main/system-name'
import type { RemoteIdentity } from '../main/remote-identity'
import { SettingsStore } from '../main/settings'
import { SettingsError } from '../main/settings-schema'
import { startDaemonAdmin } from './admin'
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
  type TerminalReport,
} from './control'
import { isUnavailable, type HostTimings } from './forked-host'
import { Hosts } from './hosts'
import { takeDebugRun } from './debug'
import {
  keyIsPrivate,
  loadHostKey,
  loadRelayHostKey,
  newHostKey,
  newRelayHostKey,
  NO_SYSTEM_ENCRYPTION,
  prepareDataFolder,
} from './key'
import { proxiedFetch } from './proxy'
import { keyPath } from './paths'
import { clearReports, daemonReport, reportsFolder, submitBundle } from './problem-report'
import { DaemonSignIn } from './sign-in'
import { readSshPort, writeSshPort } from './ssh-port'

const log = createLogger('daemon')

/** Set in the service's environment, so the daemon can say it runs as one. */
export const SERVICE_ENV = 'KETTU_DAEMON_SERVICE'

/** How long `kettu verbose on` keeps the detailed records on, as the app's switch. */
const VERBOSE_MS = 24 * 60 * 60 * 1000
/** setTimeout holds at most about 24.8 days. */
const MAX_TIMER_MS = 2 ** 31 - 1

export interface DaemonOptions {
  dataPath: string
  controlSocket: string
  version: string
  bundleDir: string
  env: NodeJS.ProcessEnv
  /** `kettu run --debug`; a marker `kettu restart --debug` left asks for the same. */
  debug: boolean
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

function debugFile(): string | null {
  const folder = logFolder()
  return folder ? path.join(folder, DEBUG_PORTS_FILE) : null
}

/**
 * A debug run logs at the debug level and opens the daemon's inspector on 127.0.0.1, then each
 * host's as it starts; a normal run removes the list a debug run left.
 */
async function startDebugMode(debug: boolean): Promise<DebugPortsFile | null> {
  const file = debugFile()
  if (!debug) {
    if (file) await removePortsFile(file)
    return null
  }
  setLogLevel('debug')
  const ports = new DebugPortsFile(file, { cdp: false })
  log.warn('Debug mode: inspectors without authentication are open on 127.0.0.1 for this run')
  try {
    ports.setInspector('daemon', openInspector())
  } catch (error) {
    log.error('Could not open the inspector', error)
  }
  return ports
}

export async function startDaemon(options: DaemonOptions): Promise<RunningDaemon> {
  const startedAt = Date.now()
  await prepareDataFolder(options.dataPath)
  let stopping = false
  let hosts: Hosts | null = null
  let debugPorts: DebugPortsFile | null = null

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
    'terminal.get': async () => {
      starting()
      return terminalReport()
    },
    'terminal.set': async ({ allowed }) => {
      starting()
      changeSettings({ remote: { terminal: allowed } })
      return terminalReport()
    },
    'report.build': async ({ request }) =>
      daemonReport(
        starting(),
        { version: options.version, dataPath: options.dataPath, settings: settings.get() },
        request,
      ),
    'verbose.set': async ({ on }) => {
      starting()
      changeSettings({ diagnostics: { verboseUntil: on ? Date.now() + VERBOSE_MS : null } })
      return { until: settings.get().diagnostics.verboseUntil }
    },
    'account.reload': async () => {
      await account?.reload()
      return null
    },
    'ssh.setup': async ({ device }) => {
      const running = starting()
      // Throws while nothing listens, before the device is added.
      const info = running.sshInfo()
      if (device) await running.addDevice(device)
      return {
        ...info,
        name: settings.get().remote.name ?? os.hostname(),
        platform: process.platform,
        version: options.version,
      }
    },
  }
  const server = await claimControlSocket(options.controlSocket, () =>
    serveControl(options.controlSocket, handlers, (message) => log.warn(message)),
  )

  let settings: SettingsStore
  let identity: RemoteIdentity
  let relayKey: RemoteIdentity | null = null
  let sshPort: number | null
  try {
    await chmod(options.controlSocket, 0o600)
    identity = await loadHostKey(options.dataPath, (message) => log.warn(message))
    settings = await SettingsStore.load(options.dataPath)
    sshPort = await readSshPort(options.dataPath)
    // The daemon always serves devices; the first run picks the direct connections' port, which
    // hold on while the relay is not in use.
    if (!settings.get().remote.enabled) settings.update({ remote: { enabled: true } })
    await clearReports(options.dataPath)
  } catch (error) {
    await release(server, options.controlSocket)
    throw error
  }
  try {
    relayKey = await loadRelayHostKey(options.dataPath)
  } catch (error) {
    log.error(`The relay cannot be used without its key: ${(error as Error).message}`)
  }
  let relayUrl = RELAY_URL
  try {
    relayUrl = relayUrlFrom(options.env[RELAY_URL_ENV])
  } catch (error) {
    log.error(`Using the relay at ${RELAY_URL} instead: ${(error as Error).message}`)
  }
  let pushUrl = PUSH_URL
  try {
    pushUrl = pushUrlFrom(options.env[PUSH_URL_ENV])
  } catch (error) {
    log.error(`Using the push gateway at ${PUSH_URL} instead: ${(error as Error).message}`)
  }
  let accountBase: string | null = null
  try {
    accountBase = accountBaseUrl(options.env)
  } catch (error) {
    log.error(`The account cannot be used: ${(error as Error).message}`)
  }
  // `kettu login` writes the sign-in; the daemon refreshes its tokens for the relay from it.
  let account: Account | null = null
  let relayToken: RelayToken | null = null
  if (accountBase) {
    account = await Account.load({
      file: accountFile(options.dataPath),
      api: new AccountApi(
        accountBase,
        proxiedFetch(() => settings.get().proxy, options.env),
      ),
      client: DAEMON_CLIENT,
      cipher: NO_SYSTEM_ENCRYPTION,
      clientInfo: async () =>
        clientInfo({
          kind: 'daemon',
          name: settings.get().remote.name ?? os.hostname(),
          os: await nodeSystemReleaseForRun(),
          arch: process.arch,
          version: options.version,
        }),
      locale: () => 'en',
      openBrowser: () => Promise.reject(new Error('The daemon signs in with kettu login')),
      bringToFront: () => {},
      avatar: async () => null,
      failureText: () => '',
      changed: () => {
        relayToken?.update()
        hosts?.settingsChanged(new Set(['remote']))
      },
      log: createLogger('account'),
    })
  }
  const signedIn = (): boolean => account?.status().state === 'signed-in'

  // Taken once the socket is this run's, so a second `kettu run` leaves the service's marker be.
  const marked = await takeDebugRun(options.dataPath).catch((error: unknown) => {
    log.warn(`Could not read the debug marker: ${(error as Error).message}`)
    return false
  })
  debugPorts = await startDebugMode(options.debug || marked)
  // The marker stays with the daemon, so a `kettu run` in a shell an agent or terminal starts is
  // not taken for the service.
  const hostEnv: NodeJS.ProcessEnv = {
    ...options.env,
    ...logEnvironment(),
    ...(options.debug || marked ? { [INSPECT_ENV]: '1' } : {}),
  }
  delete hostEnv[SERVICE_ENV]
  let admin: HostAdmin | null = null
  const reportShelf = new ReportShelf(reportsFolder(options.dataPath))
  let signIn: DaemonSignIn | null = null
  try {
    signIn = new DaemonSignIn(
      new AccountApi(
        accountBaseUrl(options.env),
        proxiedFetch(() => settings.get().proxy, options.env),
      ),
      accountFile(options.dataPath),
      NO_SYSTEM_ENCRYPTION,
      (message) => log.warn(message),
    )
  } catch (error) {
    log.warn(`Problem reports cannot be submitted: ${(error as Error).message}`)
  }
  // The data folder is the user's alone, which is all that guards the keys without encryption.
  const marketKeys = await MarketKeys.load({
    file: marketKeysFile(options.dataPath),
    cipher: NO_SYSTEM_ENCRYPTION,
    plainTextAllowed: true,
    servers: () => settings.get().marketplace.mcp,
    changed: (values) => hosts?.marketKeysChanged(values),
    log: createLogger('market-keys'),
  })
  settings.onChange((_, changed) => {
    if (changed.has('marketplace')) marketKeys.prune()
  })
  const running = new Hosts({
    bundleDir: options.bundleDir,
    dataPath: options.dataPath,
    version: options.version,
    systemLocale: matchLocale([Intl.DateTimeFormat().resolvedOptions().locale]),
    settings: () => settings.get(),
    marketKeys: () => marketKeys.values(),
    privateKey: identity.privateKey,
    newIdentity: async () => (await newHostKey(options.dataPath)).privateKey,
    relayKey: relayKey?.privateKey ?? null,
    newRelayKey: async () => (await newRelayHostKey(options.dataPath)).privateKey,
    relayUrl,
    pushUrl,
    signedIn,
    hostName: os.hostname(),
    env: hostEnv,
    inspector: (name, url) => debugPorts?.setInspector(name, url),
    timings: options.timings,
    sshPort,
    sshPortChanged: (port) => {
      writeSshPort(options.dataPath, port).catch((error: unknown) => {
        log.warn(`Could not keep the port for SSH: ${(error as Error).message}`)
      })
    },
    admin: async (deviceId, method, params) =>
      admin
        ? admin.answer(deviceId, method, params)
        : { error: { code: 'unavailable', message: 'The daemon is starting' } },
  })
  hosts = running
  if (account) {
    const signed = account
    relayToken = new RelayToken({
      current: () => signed.currentToken(),
      signedIn,
      needed: () => true,
      send: (token) => running.setToken(token),
    })
  }
  admin = await startDaemonAdmin({
    dataPath: options.dataPath,
    version: options.version,
    settings,
    hosts: running,
    env: options.env,
    marketKeys,
    report: async (request) =>
      bundleForDevice(
        await daemonReport(
          running,
          { version: options.version, dataPath: options.dataPath, settings: settings.get() },
          request,
        ),
        request,
        reportShelf,
      ),
    submitReport: async (ref) => {
      const shelved = reportShelf.get(ref)
      if (!shelved?.request || !signIn) return { ok: false, reason: 'failed' }
      return submitBundle(shelved.file, shelved.request.description, options.version, signIn)
    },
  })
  let verboseTimer: NodeJS.Timeout | null = null
  /** Applies the detailed records setting to the daemon and its agent host, until it ends. */
  const applyVerbose = (): void => {
    if (verboseTimer) clearTimeout(verboseTimer)
    verboseTimer = null
    const until = settings.get().diagnostics.verboseUntil
    const now = Date.now()
    if (until !== null && until <= now) {
      // The change comes back here, with the setting off.
      settings.update({ diagnostics: { verboseUntil: null } })
      return
    }
    const verbose = until !== null
    // A debug run logs at the debug level whether or not detailed records are on.
    const level = verbose || debugPorts ? 'debug' : 'info'
    if (verbose !== verboseRecords())
      log.info(verbose ? 'Detailed records on' : 'Detailed records off')
    setLogLevel(level)
    setVerboseRecords(verbose)
    running.setLogLevel(level, verbose)
    if (until !== null) {
      verboseTimer = setTimeout(applyVerbose, Math.min(until - now, MAX_TIMER_MS))
      verboseTimer.unref()
    }
  }
  applyVerbose()
  settings.onChange((_, changed) => {
    if (changed.has('diagnostics')) applyVerbose()
  })
  running.start()
  relayToken?.update()
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
      debug: debugPorts ? { inspectors: debugPorts.status().inspectors, file: debugFile() } : null,
      ...(hosts ? { relay: hosts.relayReport() } : {}),
    }
  }

  function terminalReport(): TerminalReport {
    return { allowed: settings.get().remote.terminal }
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
        relayToken?.stop()
        account?.stop()
        await running.stop()
        await Promise.all([settings.flush(), marketKeys.flush()])
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
