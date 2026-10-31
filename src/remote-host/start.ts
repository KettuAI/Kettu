// The remote host's process, whatever runs it: main's messages in over the control channel, the
// host's out, and each device's connection as a transport, handed over or taken by the direct
// listener. index.ts runs it in Electron's utility process, node-main.ts under Node.js.

import type { MainToRemoteHost, RemoteHostStatus, RemoteHostToMain } from '@shared/host-control'
import type { ControlChannel, PortChannel } from '@shared/port-channel'
import type { PortDevice } from '@shared/remote/device'
import { importKeyPair } from '@shared/remote/noise'
import type { Transport } from '@shared/remote/transport'
import type { LogFn } from '../agent-host/storage'
import { DeviceStore } from './devices'
import { DirectListener } from './direct'
import { RemoteServer } from './server'

export interface RemoteHostDeps {
  /** A port to the agent host for a device's session, or null while the agent host is down. */
  openAgentPort(device: PortDevice): Promise<PortChannel | null>
}

export interface StartedRemoteHost {
  /** A device's connection; it is answered once the host has started, and closed if it never was. */
  accept(transport: Transport): void
}

interface Running {
  server: RemoteServer
  direct: DirectListener
}

export function startRemoteHost(
  control: ControlChannel<MainToRemoteHost, RemoteHostToMain>,
  deps: RemoteHostDeps,
): StartedRemoteHost {
  const send = (message: RemoteHostToMain): void => control.send(message)
  const log: LogFn = (level, message) => send({ type: 'remote-host:log', level, message })
  let running: Promise<Running> | null = null

  async function begin(
    message: Extract<MainToRemoteHost, { type: 'remote-host:init' }>,
  ): Promise<Running> {
    const staticKey = await importKeyPair(Buffer.from(message.privateKey, 'base64'))
    const devices = await DeviceStore.load(message.userDataPath, log)
    const publicKey = Buffer.from(staticKey.publicKey).toString('base64')
    const status = (): RemoteHostStatus => ({
      publicKey,
      plainTextKey: message.plainTextKey,
      devices: devices.list(),
      online: server.online(),
      refused: server.refused,
      direct: direct.status,
    })
    let ready = false
    const changed = (): void => {
      if (ready) send({ type: 'remote-host:status', status: status() })
    }
    const server: RemoteServer = new RemoteServer({
      staticKey,
      devices,
      host: { name: message.hostName, platform: message.platform, version: message.appVersion },
      openAgentPort: (device) => deps.openAgentPort(device),
      changed,
      log,
    })
    const direct = new DirectListener({ server, changed, log })
    // Ready once direct connections listen or have failed, so the first status says which.
    await direct.apply(message.direct)
    ready = true
    send({ type: 'remote-host:ready' })
    send({ type: 'remote-host:status', status: status() })
    return { server, direct }
  }

  function withRunning(run: (running: Running) => unknown): boolean {
    if (!running) {
      log('warn', 'A message arrived before remote-host:init')
      return false
    }
    void running.then(run)
    return true
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
      case 'remote-host:add-device':
        withRunning(async ({ server }) => {
          const added = await server.addDevice(message.device)
          if (!added) log('warn', 'A device to add was not valid')
        })
        break
      case 'remote-host:remove-device':
        if (typeof message.id === 'string') {
          withRunning(({ server }) => server.removeDevice(message.id))
        }
        break
      case 'remote-host:direct':
        withRunning(({ direct }) => direct.apply(message.direct))
        break
      case 'remote-host:resume':
        withRunning(({ direct }) => direct.checkAddresses())
        break
      case 'remote-host:shutdown': {
        const reason = message.reason === 'remote_off' ? 'remote_off' : 'stopping'
        if (!running) {
          send({ type: 'remote-host:stopped' })
          process.exit(0)
        }
        withRunning(async ({ server, direct }) => {
          direct.stop()
          await server.stop(reason)
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
      void running.then(({ server }) => server.accept(transport))
    },
  }
}
