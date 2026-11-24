// The remote host's process, whatever runs it: main's messages in over the control channel, the
// host's out. While remote access is on it serves devices, each connection a transport handed
// over or taken by the direct listener; in the desktop app it also connects to other hosts as a
// device. index.ts runs it in Electron's utility process, node-main.ts under Node.js.

import path from 'node:path'
import type {
  AdminAnswer,
  MainToRemoteHost,
  OwnRelayInit,
  OwnRelayStatus,
  RemoteHostStatus,
  RemoteHostToMain,
} from '@shared/host-control'
import { isBrowserForward } from '@shared/browser'
import { setLocale, t } from '@shared/hosts-text'
import { isLocale } from '@shared/locale'
import { writeLog } from '@shared/log/process-log'
import type { ControlChannel, PortChannel } from '@shared/port-channel'
import { isPortError } from '@shared/port-rpc'
import type { PortDevice } from '@shared/remote/device'
import { isHostAdminEvent, type HostAdminMethod } from '@shared/remote/host-admin'
import { importKeyPair } from '@shared/remote/noise'
import { parseSshAddress, parseSshManageAction, type SshManageResult } from '@shared/remote/hosts'
import { parsePairingLink } from '@shared/remote/pairing'
import { PUSH_URL } from '@shared/remote/push'
import type { DiscoveredHosts } from '@shared/remote/discovery'
import { isAccessKey, ownRelayProblem } from '@shared/remote/own-relay'
import {
  WEB_FEATURE,
  hostProfile,
  importRelayKey,
  isRelayHostId,
  parseRelayInfo,
  relayHostId,
  relayInfoPath,
  type HostRelay,
} from '@shared/remote/relay'
import { RelayHost } from '@shared/remote/relay-host'
import { REGION_KEYS_ENV, regionKeys } from '@shared/remote/relay-regions'
import type { Transport } from '@shared/remote/transport'
import { webSocketTransport } from '@shared/remote/websocket-transport'
import type { DirectSettings } from '@shared/settings'
import type { LogFn } from '../agent-host/storage'
import { ActivityLog } from './activity'
import { HostClient } from './client'
import { DeviceStore } from './devices'
import { DiscoveryRequests } from './discovery'
import { DirectListener } from './direct'
import { HostStore, uniqueAddresses } from './hosts'
import { LoopbackListener } from './loopback'
import { DeviceNotifications, parseAttention, parseWaiting } from './notifications'
import { webPushStoreKey } from './web-push'
import { PairingCodes } from './pairing'
import { jsonOf, openRelaySocket, readRelayInfo, relayRequest } from './relay-net'
import { RemoteRegions } from './relay-regions'
import { RelaySwitch } from './relay-switch'
import { RemoteServer } from './server'
import { clearUploads } from './uploads'

/** How long an owner's call may wait for the parent, which may reach the network for it. */
const ADMIN_TIMEOUT_MS = 60_000

/** How long reading a relay's region list may take. */
const RELAY_INFO_TIMEOUT_MS = 15_000

/** How long each read of the account's hosts on a relay may take. */
const RELAY_HOSTS_TIMEOUT_MS = 8_000
/** How long a move waits for the devices on the old relay to have what was sent them. */
const RELAY_MOVE_FLUSH_MS = 2_000

async function fetchRelayInfo(url: string, pin?: string): Promise<unknown> {
  const response = await relayRequest(url, {
    ...(pin ? { pin } : {}),
    timeoutMs: RELAY_INFO_TIMEOUT_MS,
  })
  if (response.status !== 200) throw new Error(`it answered ${response.status}`)
  return jsonOf(response.text)
}

/** Reads JSON from a relay, with the relay's token as a bearer token when given. */
async function fetchRelayJson(
  url: string,
  token?: string,
): Promise<{ status: number; body: unknown }> {
  const response = await relayRequest(url, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    timeoutMs: RELAY_HOSTS_TIMEOUT_MS,
  })
  return { status: response.status, body: jsonOf(response.text) }
}

export interface RemoteHostDeps {
  /** A port to the agent host for a device's session, or null while the agent host is down. */
  openAgentPort(device: PortDevice): Promise<PortChannel | null>
  /**
   * A port to the terminal host for a device's terminals, or null while devices may not use it or
   * it cannot run.
   */
  openTerminalPort(device: PortDevice): Promise<PortChannel | null>
  /** A port to the device host for a device's mobile devices, or null while it cannot run. */
  openDevicePort?(device: PortDevice): Promise<PortChannel | null>
  /** A port to main for a host's device session; only the desktop app has one. */
  openMainPort?(hostId: string): Promise<PortChannel | null>
}

export interface StartedRemoteHost {
  /**
   * A device's connection; it is answered once the host has started, and closed if it never was
   * or does not serve devices.
   */
  accept(transport: Transport): void
}

interface Serving {
  server: RemoteServer
  direct: DirectListener
  /** The relay while Use the Kettu relay is on and the host has its key. */
  relay: RelaySwitch
  /** The host's id on the relays, null without its key. */
  relayId: string | null
  /** Under the daemon, the channels through SSH. */
  loopback: LoopbackListener | null
  /** The devices' notifications, with the host's key; null without one. */
  notifications: DeviceNotifications | null
  /** Requests from devices of the account to be added. */
  discovery: DiscoveryRequests
  /** Sends the first status and every change after it. */
  report(): void
}

interface ServeOptions {
  privateKey: string
  plainTextKey: boolean
  direct?: DirectSettings
  relayKey?: string
}

type Init = Extract<MainToRemoteHost, { type: 'remote-host:init' }>

export function startRemoteHost(
  control: ControlChannel<MainToRemoteHost, RemoteHostToMain>,
  deps: RemoteHostDeps,
): StartedRemoteHost {
  const send = (message: RemoteHostToMain): void => control.send(message)
  const log: LogFn = (level, message) => writeLog(level, 'host', message)
  let running: Promise<void> | null = null
  let init: Init | null = null
  // Serving starts and stops in the order main asks, each after the one before.
  let serving: Promise<Serving | null> = Promise.resolve(null)
  let client: HostClient | null = null
  let hostName = ''
  // Whether devices may use the terminal; each server starts with it and hears when it changes.
  let terminal = false
  // The relay: its main origin, Use the Kettu relay, and the account's access token now, which
  // the push gateway takes; with the relay token the relays get in its place once they take them.
  let relayUrl: string | null = null
  let relayEnabled = false
  let relayToken: string | null = null
  let relayOnlyToken: string | null = null
  /** What the relays get: the relay token, or the access token where they take no other. */
  const relayCredential = (): string | null =>
    relayToken === null ? null : (relayOnlyToken ?? relayToken)
  // The owner's own relay, used in place of the Kettu relay while set, and what it said of itself.
  let ownRelay: OwnRelayInit | null = null
  let ownInfo: OwnRelayStatus | null = null
  /** Whether the host signs in to a relay at all: the Kettu relay, or the owner's. */
  const relayActive = (): boolean => ownRelay !== null || relayEnabled
  /** What the relay in use gets: the own relay's access key, else the account's token. */
  const relayCredentialNow = (): string | null => ownRelay?.key ?? relayCredential()
  /** Which relay the settings ask for: the owner's, the Kettu relay or none. */
  const relayTarget = (): string => JSON.stringify(ownRelay ?? (relayEnabled ? 'kettu' : null))
  // What the running relay was made for, and the moves to another, one after another.
  let relayFor = ''
  let relayMoves: Promise<void> = Promise.resolve()
  /** The own relay as main sent it, null for none or one that is not valid. */
  const ownOf = (value: unknown): OwnRelayInit | null => {
    const { url, pin, key } = (value ?? {}) as Record<string, unknown>
    if (typeof url !== 'string' || ownRelayProblem(url) !== null || !isAccessKey(key)) return null
    return { url, pin: typeof pin === 'string' ? pin : null, key }
  }
  // The region list, the host's regions, this computer's leg to each and the day's report.
  let regions: RemoteRegions | null = null
  // What serves devices now, for the regions to reach.
  let live: Serving | null = null
  // The push gateway, what waits for the user now and whether they are at the desktop app, which
  // a server starting later begins with.
  let pushUrl = PUSH_URL
  let waiting: Record<string, string[]> = {}
  let present: boolean | null = null
  // Whether devices of the account find this host on the relay, while it is signed in to it.
  let discoverable = false
  const adminCalls = new Map<number, (answer: AdminAnswer) => void>()
  let nextAdminCall = 1

  /** Asks the parent to run an owner's call; answered with an error when it does not in time. */
  function admin(deviceId: string, method: HostAdminMethod, params: unknown): Promise<AdminAnswer> {
    const requestId = nextAdminCall++
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const message = t('remote.hostSilent', { method })
        answer({ error: { code: 'internal', message } })
      }, ADMIN_TIMEOUT_MS)
      const answer = (reply: AdminAnswer): void => {
        clearTimeout(timer)
        adminCalls.delete(requestId)
        resolve(reply)
      }
      adminCalls.set(requestId, answer)
      send({ type: 'remote-host:admin-call', requestId, deviceId, method, params })
    })
  }

  async function serve(options: ServeOptions): Promise<Serving> {
    const { userDataPath, platform, appVersion } = init!
    const staticKey = await importKeyPair(Buffer.from(options.privateKey, 'base64'))
    const uploads = path.join(userDataPath, 'remote', 'uploads')
    const [devices, activity] = await Promise.all([
      DeviceStore.load(userDataPath, log),
      ActivityLog.load(userDataPath, log),
      // What a run before was sent and nobody claimed.
      clearUploads(uploads),
    ])
    const publicKey = Buffer.from(staticKey.publicKey).toString('base64')
    const relayKey = options.relayKey
      ? await importRelayKey(Buffer.from(options.relayKey, 'base64'))
      : null
    const relayId = relayKey ? await relayHostId(relayKey.publicKey) : null
    // The host's relay while it uses it, for welcomes and pairing codes: the regions with a
    // domain alone, since only a signed list may bring one at an IP address; the owner's own
    // relay with its pin, which the code then carries.
    const onRelay = (): HostRelay | null => {
      const current = relay.current
      if (!current || !relayId) return null
      if (ownRelay) {
        return { id: relayId, urls: [ownRelay.url], ...(ownRelay.pin ? { pin: ownRelay.pin } : {}) }
      }
      return relayEnabled
        ? { id: relayId, urls: current.relays.filter((r) => !r.pin).map((r) => r.url) }
        : null
    }
    const discovery = new DiscoveryRequests({
      send: (event) => send({ type: 'remote-host:discovery', event }),
    })
    const pairing = new PairingCodes({
      hostKey: staticKey.publicKey,
      addresses: () => server.addresses,
      relay: onRelay,
      send: (codeId, state) => send({ type: 'remote-host:pairing', codeId, pairing: state }),
    })
    const status = (): RemoteHostStatus => ({
      publicKey,
      plainTextKey: options.plainTextKey,
      devices: devices.list(),
      online: server.online(),
      refused: server.refused,
      direct: direct.status,
      ...(loopback ? { sshPort: loopback.port } : {}),
      relays: relay.current && relayActive() && relayCredentialNow() ? relay.current.status : [],
      ...(ownRelay && relay.current
        ? {
            ownRelay: {
              version: ownInfo?.version ?? null,
              web: ownInfo?.web ?? false,
              rtt: relay.current.legs()[0]?.hostRtt ?? null,
            },
          }
        : {}),
    })
    let ready = false
    const changed = (): void => {
      if (ready) send({ type: 'remote-host:status', status: status() })
    }
    const server: RemoteServer = new RemoteServer({
      staticKey,
      devices,
      activity,
      pairing,
      discovery,
      host: { name: hostName, platform, version: appVersion },
      uploads,
      openAgentPort: (device) => deps.openAgentPort(device),
      terminal,
      openTerminalPort: (device) => deps.openTerminalPort(device),
      openDevicePort: (device) => deps.openDevicePort?.(device) ?? Promise.resolve(null),
      admin,
      changed,
      log,
      relay: onRelay,
      ...(regions
        ? {
            regions: {
              offered: () => regions?.offered ?? false,
              message: () => regions?.regionsMessage(relay.current?.legs() ?? []) ?? null,
              preferred: (deviceId: string, value: unknown) =>
                void regions?.preferred(deviceId, value),
              seen: (deviceId: string) => regions?.seen(deviceId),
            },
          }
        : {}),
      notifications: () => notifications,
    })
    const notifications =
      relayKey && relayId
        ? new DeviceNotifications({
            devices,
            key: relayKey,
            hostId: relayId,
            url: pushUrl,
            hostName: () => server.options.host.name,
            token: () => relayToken,
            showing: (deviceId, sessionId) => server.showing(deviceId, sessionId),
            foreground: (deviceId) => server.foreground(deviceId),
            tell: (deviceId, message) => server.withdrawn(deviceId, message),
            storeKey: webPushStoreKey(Buffer.from(options.privateKey, 'base64')),
            log,
          })
        : null
    notifications?.setWaiting(waiting)
    if (present !== null) notifications?.setPresent(present)
    const relay = new RelaySwitch(() => {
      if (!relayKey || !relayId) return null
      const own = ownRelay
      if (own) {
        // Read at each sign-in, since a relay that restarted may be another version or serve the
        // web client now.
        let signedIn = false
        let ownHost: RelayHost | null = null
        const ownChanged = (): void => {
          const connected = ownHost?.status[0]?.connection.state === 'connected'
          if (connected && !signedIn) void readOwnInfo(own, changed)
          signedIn = connected
          changed()
        }
        ownHost = new RelayHost({
          main: own.url,
          own: { id: 'own', url: own.url, ...(own.pin ? { pin: own.pin } : {}) },
          id: relayId,
          key: relayKey,
          openSocket: openRelaySocket,
          fetchInfo: fetchRelayInfo,
          accepted: (socket) =>
            void webSocketTransport(socket, true).then(
              (transport) => server.accept(transport, 'relay'),
              () => {},
            ),
          changed: ownChanged,
          legsChanged: changed,
          log,
        })
        return ownHost
      }
      if (!relayUrl) return null
      const host = new RelayHost({
        main: relayUrl,
        id: relayId,
        key: relayKey,
        openSocket: openRelaySocket,
        fetchInfo: fetchRelayInfo,
        // Each device the relay joins is a connection like a direct one, which may also ask to be
        // added as a device of the account.
        accepted: (socket) =>
          void webSocketTransport(socket, true).then(
            (transport) => server.accept(transport, 'relay'),
            () => {},
          ),
        profile: () =>
          discovery.on
            ? hostProfile(staticKey.publicKey, server.options.host.name, platform)
            : null,
        changed,
        drained: () => regions?.hostDrained(),
        failed: () => regions?.regionFailed(),
        connected: (region, ok) => regions?.hostConnected(region, ok),
        measured: (region, rtt) => regions?.hostMeasured(region, rtt),
        legsChanged: () => server.regionsChanged(),
        log,
      })
      host.setPlan(regions?.plan() ?? null)
      return host
    })
    const direct = new DirectListener({ server, changed, log, webRoot: init!.webRoot ?? null })
    // Ready once direct connections listen or have failed, so the first status says which.
    await direct.apply(options.direct)
    const sshPort = init!.sshPort
    const loopback =
      sshPort === undefined ? null : await LoopbackListener.start(server, sshPort, log)
    server.startSweeping()
    relay.set(relayActive(), relayCredentialNow())
    relayFor = relayTarget()
    const report = (): void => {
      ready = true
      changed()
    }
    const started: Serving = {
      server,
      direct,
      relay,
      relayId,
      loopback,
      notifications,
      discovery,
      report,
    }
    live = started
    applyDiscovery(started)
    return started
  }

  /**
   * The relay devices reach the host through once it moves: the owner's with its pin, the Kettu
   * relay's main origin, whose regions the next welcome brings, or none.
   */
  function nextRelay(
    { relayId }: Serving,
    own: OwnRelayInit | null,
    enabled: boolean,
  ): HostRelay | null {
    if (!relayId) return null
    if (own) return { id: relayId, urls: [own.url], ...(own.pin ? { pin: own.pin } : {}) }
    if (enabled && relayUrl && relayCredential()) return { id: relayId, urls: [relayUrl] }
    return null
  }

  /**
   * Brings the relay in line with the settings. On a move the devices online hear the new relay,
   * and the host leaves the one they use only once they have it, or after a short wait.
   */
  function applyRelay(current: Serving): Promise<void> {
    relayMoves = relayMoves
      .then(async () => {
        let target = relayTarget()
        if (target !== relayFor) {
          for (;;) {
            const enabled = ownRelay === null && relayEnabled
            await within(
              current.server.relayMoved(nextRelay(current, ownRelay, enabled)),
              RELAY_MOVE_FLUSH_MS,
            )
            // Moved again meanwhile: the devices hear the latest before the host leaves.
            if (relayTarget() === target) break
            target = relayTarget()
          }
          current.relay.stop()
        }
        current.relay.set(relayActive(), relayCredentialNow())
        relayFor = target
        applyDiscovery(current)
        current.server.options.changed()
      })
      .catch((error: unknown) => log('error', `Cannot move the relay: ${(error as Error).message}`))
    return relayMoves
  }

  /** What the owner's relay says of itself: its version, and whether it serves the web client. */
  async function readOwnInfo(own: OwnRelayInit, changed: () => void): Promise<void> {
    try {
      const info = parseRelayInfo(
        await readRelayInfo(`${own.url}${relayInfoPath()}`, own.pin ?? undefined),
      )
      if (ownRelay !== own || !info) return
      ownInfo = { version: info.version, web: info.features.includes(WEB_FEATURE), rtt: null }
      changed()
    } catch {
      // Read again when the relay is next chosen; the connection says whether it is reached.
    }
  }

  /** Takes discovery requests while discoverable, on the relay and signed in, and says so there. */
  function applyDiscovery({ discovery, relay }: Serving): void {
    discovery.setEnabled(
      discoverable &&
        relay.current !== null &&
        ownRelay === null &&
        relayEnabled &&
        relayCredential() !== null,
    )
    relay.current?.profileChanged()
  }

  async function stopServing(
    current: Serving | null,
    reason: 'remote_off' | 'stopping',
  ): Promise<null> {
    if (!current) return null
    if (live === current) live = null
    current.notifications?.stop()
    current.discovery.setEnabled(false)
    current.relay.stop()
    current.direct.stop()
    current.loopback?.stop()
    await current.server.stop(reason)
    return null
  }

  async function connectOut(
    device: NonNullable<Init['device']>,
  ): Promise<{ client: HostClient; report(): void }> {
    const { userDataPath, appVersion } = init!
    const key = await importKeyPair(Buffer.from(device.privateKey, 'base64'))
    const hosts = await HostStore.load(userDataPath, log)
    let ready = false
    const started: HostClient = new HostClient({
      key,
      hosts,
      client: { kind: 'desktop', version: appVersion, platform: device.platform },
      name: () => hostName,
      openMainPort: deps.openMainPort,
      ...(relayUrl
        ? {
            relay: {
              main: relayUrl,
              token: relayCredential,
              openSocket: openRelaySocket,
              fetchJson: fetchRelayJson,
              ...(regions ? { regions } : {}),
            },
          }
        : {}),
      changed: () => {
        if (ready) send({ type: 'remote-host:hosts', hosts: started.list() })
      },
      pairing: (pairId, pairing) => send({ type: 'remote-host:host-pairing', pairId, pairing }),
      log,
    })
    started.start()
    const report = (): void => {
      ready = true
      send({ type: 'remote-host:hosts', hosts: started.list() })
    }
    return { client: started, report }
  }

  async function begin(message: Init): Promise<void> {
    init = message
    hostName = message.hostName
    terminal = message.terminal === true
    if (typeof message.push === 'string') pushUrl = message.push
    waiting = parseWaiting(message.waiting) ?? {}
    if (typeof message.present === 'boolean') present = message.present
    discoverable = message.discoverable === true
    if (message.relay && typeof message.relay.url === 'string') {
      relayUrl = message.relay.url
      ownRelay = ownOf(message.relay.own)
      relayEnabled = ownRelay === null && message.relay.enabled === true
      relayToken = typeof message.relay.token === 'string' ? message.relay.token : null
      const relayOnly = message.relay.relayToken
      relayOnlyToken = relayToken && typeof relayOnly === 'string' ? relayOnly : null
      regions = await loadRegions(message, relayUrl)
    }
    // Without its own key the app still serves devices, and the other way round.
    let reportHosts: (() => void) | null = null
    if (message.device) {
      try {
        const out = await connectOut(message.device)
        client = out.client
        reportHosts = out.report
      } catch (error) {
        log('error', `Cannot connect to other hosts: ${(error as Error).message}`)
      }
    }
    const { privateKey, plainTextKey, direct } = message
    const relayKey = typeof message.relay?.key === 'string' ? message.relay.key : undefined
    const started = privateKey ? serve({ privateKey, plainTextKey, direct, relayKey }) : null
    if (started) serving = started
    const first = await started
    send({ type: 'remote-host:ready' })
    first?.report()
    reportHosts?.()
    regions?.update()
  }

  async function loadRegions(message: Init, main: string): Promise<RemoteRegions | null> {
    try {
      return await RemoteRegions.load({
        userDataPath: message.userDataPath,
        main,
        // Only a development relay may bring keys of its own.
        keys: regionKeys(main, process.env[REGION_KEYS_ENV]),
        app: message.sshPort === undefined ? 'desktop' : 'daemon',
        device: message.device !== undefined,
        accessToken: () => relayToken,
        relayToken: () => relayOnlyToken,
        relayOn: () => relayEnabled,
        plan: (plan) => live?.relay.current?.setPlan(plan),
        hostChanged: () => live?.server.regionsChanged(),
        timesChanged: (prefer) => client?.regionsChanged(prefer),
        log,
      })
    } catch (error) {
      log('error', `Cannot keep the relay regions: ${(error as Error).message}`)
      return null
    }
  }

  function withRunning(run: () => unknown): boolean {
    if (!running) {
      log('warn', 'A message arrived before remote-host:init')
      return false
    }
    void running.then(run)
    return true
  }

  /** Runs `run` on the server while it serves; false when it never could, as before init. */
  function withServing(run: (serving: Serving) => unknown, otherwise?: () => void): boolean {
    return withRunning(async () => {
      const current = await serving.catch(() => null)
      if (current) await run(current)
      else otherwise?.()
    })
  }

  function withClient(run: (client: HostClient) => unknown): void {
    withRunning(() => {
      if (client) return run(client)
      log('warn', 'A message for other hosts arrived while none can be connected')
    })
  }

  /** This computer's own key as a host while it serves devices, which listing leaves out. */
  async function ownKey(): Promise<string | null> {
    const current = await serving.catch(() => null)
    return current
      ? Buffer.from(current.server.options.staticKey.publicKey).toString('base64')
      : null
  }

  process.on('unhandledRejection', (reason) => {
    log('error', `Unhandled rejection: ${(reason as Error)?.stack ?? String(reason)}`)
  })

  control.onMessage((message) => {
    switch (message?.type) {
      case 'remote-host:init':
        if (running) {
          log('warn', 'remote-host:init arrived twice; ignored')
          break
        }
        if (isLocale(message.locale)) setLocale(message.locale)
        running = begin(message)
        running.catch((error: unknown) => {
          // Without its key or its devices the host cannot answer anyone; main restarts it.
          console.error('Remote host failed to start:', (error as Error)?.message ?? error)
          process.exit(1)
        })
        break
      case 'remote-host:locale':
        if (isLocale(message.locale)) setLocale(message.locale)
        break
      case 'remote-host:serve': {
        const { privateKey, plainTextKey, direct } = message
        if (typeof privateKey !== 'string') break
        const relayKey = typeof message.relayKey === 'string' ? message.relayKey : undefined
        withRunning(() => {
          serving = serving.then(async (current) => {
            if (current) return current
            const started = await serve({
              privateKey,
              plainTextKey: plainTextKey === true,
              direct,
              relayKey,
            })
            started.report()
            return started
          })
          serving.catch((error: unknown) => {
            console.error('Remote access failed to start:', (error as Error)?.message ?? error)
            process.exit(1)
          })
        })
        break
      }
      case 'remote-host:stop-serving': {
        const { requestId } = message
        withRunning(() => {
          serving = serving.then((current) => stopServing(current, 'remote_off'))
          if (Number.isSafeInteger(requestId)) {
            void serving.then(() => send({ type: 'remote-host:stop-serving', requestId }))
          }
        })
        break
      }
      case 'remote-host:add-device':
        withServing(async ({ server }) => {
          const added = await server.addDevice(message.device)
          if (!added) log('warn', 'A device to add was not valid')
        })
        break
      case 'remote-host:remove-device':
        if (typeof message.id === 'string') {
          withServing(({ server }) => server.removeDevice(message.id))
        }
        break
      case 'remote-host:direct':
        withServing(({ direct }) => direct.apply(message.direct))
        break
      case 'remote-host:relay': {
        const own = message.own === undefined ? ownRelay : ownOf(message.own)
        relayEnabled = own === null && message.enabled === true
        ownRelay = own
        ownInfo = null
        regions?.update()
        withServing(applyRelay)
        break
      }
      case 'remote-host:discoverable':
        discoverable = message.enabled === true
        withServing(applyDiscovery)
        break
      case 'remote-host:discovery-answer':
        if (Number.isSafeInteger(message.requestId)) {
          withServing(({ discovery }) =>
            discovery.answer(
              message.requestId,
              message.add === true,
              typeof message.name === 'string' ? message.name : '',
            ),
          )
        }
        break
      case 'remote-host:token': {
        const had = relayCredential()
        relayToken = typeof message.token === 'string' ? message.token : null
        relayOnlyToken = relayToken && typeof message.relay === 'string' ? message.relay : null
        const now = relayCredential()
        withRunning(() => regions?.update())
        withServing((current) => {
          // The owner's relay takes its access key, whatever the account does.
          if (!ownRelay) current.relay.current?.setToken(relayEnabled ? now : null)
          applyDiscovery(current)
        })
        // Hosts not reached for want of a sign-in are tried now.
        if (!had && now) withRunning(() => client?.resume())
        // Without a token the relay may not be used, so links through it end too.
        if (had && !now) withRunning(() => client?.leaveRelay())
        break
      }
      case 'remote-host:relay-retry':
        withServing(({ relay }) => relay.current?.retry())
        break
      case 'remote-host:terminal': {
        const allowed = message.allowed === true
        terminal = allowed
        withServing(({ server: s }) => s.setTerminal(allowed))
        break
      }
      case 'remote-host:resume':
        withServing(({ direct }) => direct.checkAddresses())
        withRunning(() => client?.resume())
        break
      case 'remote-host:rename-device':
        if (typeof message.id === 'string') {
          withServing(async ({ server: s }) => {
            if (!(await s.renameDevice(message.id, message.name, 'owner'))) {
              log('warn', 'A device to rename was not there or its name was not one')
            }
          })
        }
        break
      case 'remote-host:pair':
        if (Number.isSafeInteger(message.codeId)) {
          withServing(({ server: s }) => s.options.pairing.open(message.codeId))
        }
        break
      case 'remote-host:pair-close':
        withServing(({ server: s }) => s.options.pairing.close(message.codeId))
        break
      case 'remote-host:pair-answer':
        withServing(({ server: s }) =>
          s.options.pairing.answer(message.codeId, {
            add: message.add === true,
            name: typeof message.name === 'string' ? message.name : '',
          }),
        )
        break
      case 'remote-host:activity': {
        const { requestId, id } = message
        if (!Number.isSafeInteger(requestId)) break
        const none = (): void => send({ type: 'remote-host:activity', requestId, events: [] })
        const answered = withServing(
          ({ server: s }) =>
            send({
              type: 'remote-host:activity',
              requestId,
              events: typeof id === 'string' ? s.options.activity.list(id) : [],
            }),
          none,
        )
        if (!answered) none()
        break
      }
      case 'remote-host:admin-result': {
        const answer = adminCalls.get(message.requestId)
        if (!answer) break
        if ('error' in message) {
          const { error } = message
          answer({
            error: isPortError(error)
              ? { code: error.code, message: error.message }
              : { code: 'internal', message: t('remote.hostCouldNotAnswer') },
          })
        } else answer({ result: message.result })
        break
      }
      case 'remote-host:admin-event': {
        const { event, deviceId } = message
        const valid =
          typeof event === 'object' &&
          event !== null &&
          isHostAdminEvent(event) &&
          (deviceId === null || typeof deviceId === 'string')
        if (!valid) {
          log('warn', 'Ignored an event for devices that is not one')
          break
        }
        withServing(({ server: s }) => s.adminEvent(event, deviceId))
        break
      }
      case 'remote-host:attention': {
        const attention = parseAttention(message.attention)
        if (!attention) {
          log('warn', 'Ignored an attention message that is not one')
          break
        }
        withServing(({ notifications }) => notifications?.attention(attention))
        break
      }
      case 'remote-host:waiting': {
        const sessions = parseWaiting(message.sessions)
        if (!sessions) break
        waiting = sessions
        withServing(({ notifications }) => notifications?.setWaiting(sessions))
        break
      }
      case 'remote-host:seen':
        if (typeof message.sessionId === 'string') {
          const { sessionId } = message
          withServing(({ notifications }) => notifications?.seen(sessionId))
        }
        break
      case 'remote-host:presence':
        if (typeof message.present === 'boolean') {
          const now = message.present
          present = now
          withServing(({ notifications }) => notifications?.setPresent(now))
        }
        break
      case 'remote-host:host-name':
        if (typeof message.name === 'string') {
          hostName = message.name
          withServing(({ server: s, relay }) => {
            s.setHostName(message.name)
            relay.current?.profileChanged()
          })
        }
        break
      case 'remote-host:reset': {
        const { requestId } = message
        if (!Number.isSafeInteger(requestId)) break
        const done = (): void => send({ type: 'remote-host:reset', requestId })
        const reset = withServing(async ({ server: s }) => {
          await s.reset()
          done()
        }, done)
        if (!reset) done()
        break
      }
      case 'remote-host:pair-host': {
        const { pairId, link, model } = message
        if (!Number.isSafeInteger(pairId) || typeof link !== 'string') break
        const payload = parsePairingLink(link)
        if (!payload) {
          send({
            type: 'remote-host:host-pairing',
            pairId,
            pairing: { state: 'failed', reason: 'void' },
          })
          break
        }
        withClient((c) => c.pair(pairId, payload, typeof model === 'string' ? model : ''))
        break
      }
      case 'remote-host:add-ssh-host': {
        const { pairId, model } = message
        const address = parseSshAddress(message.address)
        if (!Number.isSafeInteger(pairId)) break
        if (!address) {
          send({
            type: 'remote-host:host-pairing',
            pairId,
            pairing: { state: 'failed', reason: 'ssh_failed' },
          })
          break
        }
        withClient((c) => c.addSsh(pairId, address, typeof model === 'string' ? model : ''))
        break
      }
      case 'remote-host:discover': {
        const { requestId } = message
        if (!Number.isSafeInteger(requestId)) break
        const answer = (result: DiscoveredHosts): void =>
          send({ type: 'remote-host:discovered', requestId, result })
        const started = withRunning(async () =>
          answer(client ? await client.discover(await ownKey()) : { state: 'unavailable' }),
        )
        if (!started) answer({ state: 'unavailable' })
        break
      }
      case 'remote-host:pair-discovered': {
        const { pairId, relayId, model } = message
        if (!Number.isSafeInteger(pairId)) break
        if (!isRelayHostId(relayId)) {
          send({
            type: 'remote-host:host-pairing',
            pairId,
            pairing: { state: 'failed', reason: 'host_offline' },
          })
          break
        }
        withClient(async (c) =>
          c.pairDiscovered(pairId, relayId, await ownKey(), typeof model === 'string' ? model : ''),
        )
        break
      }
      case 'remote-host:pair-match':
        if (Number.isSafeInteger(message.pairId) && typeof message.match === 'boolean') {
          withClient((c) => c.matchPairing(message.pairId, message.match))
        }
        break
      case 'remote-host:pair-host-close':
        if (Number.isSafeInteger(message.pairId)) withClient((c) => c.closePairing(message.pairId))
        break
      case 'remote-host:rename-on-host':
        if (typeof message.id === 'string' && typeof message.name === 'string') {
          withClient((c) => {
            if (!c.rename(message.id, message.name)) {
              log('warn', 'A host to rename this computer on is not connected')
            }
          })
        }
        break
      case 'remote-host:host-addresses':
        if (typeof message.id === 'string' && Array.isArray(message.addresses)) {
          withClient((c) => c.setAddresses(message.id, uniqueAddresses(message.addresses)))
        }
        break
      case 'remote-host:remove-host':
        if (typeof message.id === 'string') withClient((c) => c.remove(message.id))
        break
      case 'remote-host:manage-ssh': {
        const { requestId, id } = message
        if (!Number.isSafeInteger(requestId)) break
        const answer = (result: SshManageResult): void =>
          send({ type: 'remote-host:ssh-managed', requestId, result })
        const action = parseSshManageAction(message.action)
        if (typeof id !== 'string' || !action) {
          answer({ ok: false, reason: 'unknown_host' })
          break
        }
        const started = withRunning(async () =>
          answer(
            client ? await client.manageSsh(id, action) : { ok: false, reason: 'unknown_host' },
          ),
        )
        if (!started) answer({ ok: false, reason: 'unknown_host' })
        break
      }
      case 'remote-host:forward': {
        const { requestId, hostId, sessionId, forward } = message
        if (!Number.isSafeInteger(requestId)) break
        const answer = (port: number | null): void =>
          send({ type: 'remote-host:forwarding', requestId, port })
        if (
          typeof hostId !== 'string' ||
          typeof sessionId !== 'string' ||
          !isBrowserForward(forward)
        ) {
          answer(null)
          break
        }
        const started = withRunning(async () =>
          answer(client ? await client.forward(hostId, sessionId, forward) : null),
        )
        if (!started) answer(null)
        break
      }
      case 'remote-host:forward-close':
        if (typeof message.hostId === 'string' && typeof message.sessionId === 'string') {
          client?.closeForwards(message.hostId, message.sessionId)
        }
        break
      case 'remote-host:shutdown': {
        const reason = message.reason === 'remote_off' ? 'remote_off' : 'stopping'
        if (!running) {
          send({ type: 'remote-host:stopped' })
          process.exit(0)
        }
        withRunning(async () => {
          const kept = regions?.stop()
          const stopped = serving.then((current) => stopServing(current, reason))
          serving = stopped
          await Promise.all([stopped, client?.stop(), kept])
          send({ type: 'remote-host:stopped' })
          // Lets remote-host:stopped leave before the process ends.
          setImmediate(() => process.exit(0))
        })
        break
      }
    }
  })

  return {
    accept: (transport) => {
      if (!running) return transport.close()
      void running
        .then(() => serving)
        .then((current) => (current ? current.server.accept(transport) : transport.close()))
    },
  }
}

/** Settles with `promise`, or after `ms` when it takes longer. */
function within(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms)
  })
  return Promise.race([promise.then(() => {}), timeout]).finally(() => clearTimeout(timer))
}
