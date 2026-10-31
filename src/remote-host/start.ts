// The remote host's process, whatever runs it: main's messages in over the control channel, the
// host's out, and each device's connection as a transport. index.ts runs it in Electron's utility
// process, node-main.ts under Node.js.

import type { MainToRemoteHost, RemoteHostStatus, RemoteHostToMain } from '@shared/host-control'
import type { ControlChannel, PortChannel } from '@shared/port-channel'
import type { PortDevice } from '@shared/remote/device'
import { importKeyPair } from '@shared/remote/noise'
import type { Transport } from '@shared/remote/transport'
import type { LogFn } from '../agent-host/storage'
import { DeviceStore } from './devices'
import { RemoteServer } from './server'

export interface RemoteHostDeps {
  /** A port to the agent host for a device's session, or null while the agent host is down. */
  openAgentPort(device: PortDevice): Promise<PortChannel | null>
}

export interface StartedRemoteHost {
  /** A device's connection; it is answered once the host has started, and closed if it never was. */
  accept(transport: Transport): void
}

export function startRemoteHost(
  control: ControlChannel<MainToRemoteHost, RemoteHostToMain>,
  deps: RemoteHostDeps,
): StartedRemoteHost {
  const send = (message: RemoteHostToMain): void => control.send(message)
  const log: LogFn = (level, message) => send({ type: 'remote-host:log', level, message })
  let server: Promise<RemoteServer> | null = null

  async function begin(
    message: Extract<MainToRemoteHost, { type: 'remote-host:init' }>,
  ): Promise<RemoteServer> {
    const staticKey = await importKeyPair(Buffer.from(message.privateKey, 'base64'))
    const devices = await DeviceStore.load(message.userDataPath, log)
    const publicKey = Buffer.from(staticKey.publicKey).toString('base64')
    const status = (): RemoteHostStatus => ({
      publicKey,
      plainTextKey: message.plainTextKey,
      devices: devices.list(),
      online: started.online(),
      refused: started.refused,
    })
    const started: RemoteServer = new RemoteServer({
      staticKey,
      devices,
      host: { name: message.hostName, platform: message.platform, version: message.appVersion },
      openAgentPort: (device) => deps.openAgentPort(device),
      changed: () => send({ type: 'remote-host:status', status: status() }),
      log,
    })
    send({ type: 'remote-host:ready' })
    send({ type: 'remote-host:status', status: status() })
    return started
  }

  function withServer(run: (server: RemoteServer) => unknown): boolean {
    if (!server) {
      log('warn', 'A message arrived before remote-host:init')
      return false
    }
    void server.then(run)
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
        if (server) {
          log('warn', 'remote-host:init arrived twice; ignored')
          break
        }
        server = begin(message)
        server.catch((error: unknown) => {
          // Without its key or its devices the host cannot answer anyone; main restarts it.
          console.error('Remote host failed to start:', (error as Error)?.message ?? error)
          process.exit(1)
        })
        break
      case 'remote-host:add-device':
        withServer(async (s) => {
          if (!(await s.addDevice(message.device))) log('warn', 'A device to add was not valid')
        })
        break
      case 'remote-host:remove-device':
        if (typeof message.id === 'string') withServer((s) => s.removeDevice(message.id))
        break
      case 'remote-host:shutdown': {
        const reason = message.reason === 'remote_off' ? 'remote_off' : 'stopping'
        if (!server) {
          send({ type: 'remote-host:stopped' })
          process.exit(0)
        }
        withServer(async (s) => {
          await s.stop(reason)
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
      if (!server) return transport.close()
      void server.then((s) => s.accept(transport))
    },
  }
}
