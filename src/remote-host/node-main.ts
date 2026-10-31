// Entry of the remote host under Node.js, started with `child_process.fork`: control messages over
// its IPC, devices' connections on the local socket `remote-host:init` may name, and each device's
// session as a connection to the agent host's socket.

import type { MainToRemoteHost, RemoteHostToMain } from '@shared/host-control'
import { connectPort } from '@shared/socket-port'
import { startRemoteHost } from './start'
import { listenTransports } from './stream-transport'

function send(message: RemoteHostToMain): void {
  if (process.connected) process.send!(message)
}

function fail(error: unknown): never {
  console.error('Remote host cannot take connections:', error)
  process.exit(1)
}

let agentHostSocket: string | null = null
// Settled once the socket listens: the host sees remote-host:init only then, so it reports ready
// only when a device can connect, and what follows the init waits behind it.
let listening: Promise<void> | null = null

const host = startRemoteHost(
  {
    send,
    onMessage: (listener) => {
      process.on('message', (data) => {
        const message = data as MainToRemoteHost
        if (message?.type === 'remote-host:init' && !listening) {
          if (!message.agentHostSocket) fail(new Error('remote-host:init names no agent host'))
          agentHostSocket = message.agentHostSocket
          const socketPath = message.socketPath
          listening = (
            socketPath
              ? listenTransports(socketPath, (transport) => host.accept(transport))
              : Promise.resolve()
          ).then(() => listener(message), fail)
        } else if (listening) {
          void listening.then(() => listener(message))
        } else {
          listener(message)
        }
      })
      // Without the process that started it, nothing can reach the host any more.
      process.on('disconnect', () => listener({ type: 'remote-host:shutdown', reason: 'stopping' }))
    },
  },
  {
    openAgentPort: async (device) => {
      if (!agentHostSocket) return null
      const port = await connectPort(agentHostSocket).catch(() => null)
      // The agent host learns whom the port serves from its first message.
      port?.send({ type: 'host:connect', device })
      return port
    },
  },
)
