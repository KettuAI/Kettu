// The remote host's process, whatever runs it: main's messages in over the control channel, the
// host's out. While remote access is on it serves devices, each connection a transport handed
// over or taken by the direct listener; in the desktop app it also connects to other hosts as a
// device. index.ts runs it in Electron's utility process, node-main.ts under Node.js.

import path from 'node:path'
import type {
  AdminAnswer,
  MainToRemoteHost,
  RemoteHostStatus,
  RemoteHostToMain,
} from '@shared/host-control'
import { isBrowserForward } from '@shared/browser'
import type { ControlChannel, PortChannel } from '@shared/port-channel'
import { isPortError } from '@shared/port-rpc'
import type { PortDevice } from '@shared/remote/device'
import { isHostAdminEvent, type HostAdminMethod } from '@shared/remote/host-admin'
import { importKeyPair } from '@shared/remote/noise'
import { parseSshTarget } from '@shared/remote/hosts'
import { parsePairingLink } from '@shared/remote/pairing'
import type { Transport } from '@shared/remote/transport'
import type { DirectSettings } from '@shared/settings'
import type { LogFn } from '../agent-host/storage'
import { ActivityLog } from './activity'
import { HostClient } from './client'
import { DeviceStore } from './devices'
import { DirectListener } from './direct'
import { HostStore, uniqueAddresses } from './hosts'
import { LoopbackListener } from './loopback'
import { PairingCodes } from './pairing'
import { RemoteServer } from './server'
import { clearUploads } from './uploads'

/** How long an owner's call may wait for the parent, which may reach the network for it. */
const ADMIN_TIMEOUT_MS = 60_000

export interface RemoteHostDeps {
  /** A port to the agent host for a device's session, or null while the agent host is down. */
  openAgentPort(device: PortDevice): Promise<PortChannel | null>
  /**
   * A port to the terminal host for a device's terminals, or null while devices may not use it or
   * it cannot run.
   */
  openTerminalPort(device: PortDevice): Promise<PortChannel | null>
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
  /** Under the daemon, the channels through SSH. */
  loopback: LoopbackListener | null
  /** Sends the first status and every change after it. */
  report(): void
}

interface ServeOptions {
  privateKey: string
  plainTextKey: boolean
  direct?: DirectSettings
}

type Init = Extract<MainToRemoteHost, { type: 'remote-host:init' }>

export function startRemoteHost(
  control: ControlChannel<MainToRemoteHost, RemoteHostToMain>,
  deps: RemoteHostDeps,
): StartedRemoteHost {
  const send = (message: RemoteHostToMain): void => control.send(message)
  const log: LogFn = (level, message) => send({ type: 'remote-host:log', level, message })
  let running: Promise<void> | null = null
  let init: Init | null = null
  // Serving starts and stops in the order main asks, each after the one before.
  let serving: Promise<Serving | null> = Promise.resolve(null)
  let client: HostClient | null = null
  let hostName = ''
  // Whether devices may use the terminal; each server starts with it and hears when it changes.
  let terminal = false
  const adminCalls = new Map<number, (answer: AdminAnswer) => void>()
  let nextAdminCall = 1

  /** Asks the parent to run an owner's call; answered with an error when it does not in time. */
  function admin(deviceId: string, method: HostAdminMethod, params: unknown): Promise<AdminAnswer> {
    const requestId = nextAdminCall++
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const message = `The host did not answer "${method}" in time`
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
    const pairing = new PairingCodes({
      hostKey: staticKey.publicKey,
      addresses: () => server.addresses,
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
      host: { name: hostName, platform, version: appVersion },
      uploads,
      openAgentPort: (device) => deps.openAgentPort(device),
      terminal,
      openTerminalPort: (device) => deps.openTerminalPort(device),
      admin,
      changed,
      log,
    })
    const direct = new DirectListener({ server, changed, log, webRoot: init!.webRoot ?? null })
    // Ready once direct connections listen or have failed, so the first status says which.
    await direct.apply(options.direct)
    const sshPort = init!.sshPort
    const loopback =
      sshPort === undefined ? null : await LoopbackListener.start(server, sshPort, log)
    server.startSweeping()
    const report = (): void => {
      ready = true
      changed()
    }
    return { server, direct, loopback, report }
  }

  async function stopServing(
    current: Serving | null,
    reason: 'remote_off' | 'stopping',
  ): Promise<null> {
    if (!current) return null
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
    const started = privateKey ? serve({ privateKey, plainTextKey, direct }) : null
    if (started) serving = started
    const current = await started
    send({ type: 'remote-host:ready' })
    current?.report()
    reportHosts?.()
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

  process.on('unhandledRejection', (reason) => {
    const message = `Unhandled rejection: ${(reason as Error)?.stack ?? String(reason)}`
    console.error(message)
    log('error', message)
  })

  control.onMessage((message) => {
    switch (message?.type) {
      case 'remote-host:init':
        if (running) {
          log('warn', 'remote-host:init arrived twice; ignored')
          break
        }
        running = begin(message)
        running.catch((error: unknown) => {
          // Without its key or its devices the host cannot answer anyone; main restarts it.
          console.error('Remote host failed to start:', (error as Error)?.message ?? error)
          process.exit(1)
        })
        break
      case 'remote-host:serve': {
        const { privateKey, plainTextKey, direct } = message
        if (typeof privateKey !== 'string') break
        withRunning(() => {
          serving = serving.then(async (current) => {
            if (current) return current
            const started = await serve({ privateKey, plainTextKey: plainTextKey === true, direct })
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
              : { code: 'internal', message: 'The host could not answer' },
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
      case 'remote-host:host-name':
        if (typeof message.name === 'string') {
          hostName = message.name
          withServing(({ server: s }) => s.setHostName(message.name))
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
        const target = parseSshTarget(message.target)
        if (!Number.isSafeInteger(pairId)) break
        if (!target) {
          send({
            type: 'remote-host:host-pairing',
            pairId,
            pairing: { state: 'failed', reason: 'ssh_failed' },
          })
          break
        }
        withClient((c) => c.addSsh(pairId, target, typeof model === 'string' ? model : ''))
        break
      }
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
          const stopped = serving.then((current) => stopServing(current, reason))
          serving = stopped
          await Promise.all([stopped, client?.stop()])
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
