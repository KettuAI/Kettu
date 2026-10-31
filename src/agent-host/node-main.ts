// Entry of the agent host under Node.js, started with `child_process.fork`: control messages over
// its IPC, and each port as a connection to the local socket that `host:init` names.

import type { HostToMain, MainToHost } from '@shared/host-control'
import { listenPorts } from '@shared/socket-port'
import { startAgentHost } from './start'

function send(message: HostToMain): void {
  if (process.connected) process.send!(message)
}

function fail(error: unknown): never {
  console.error('Agent host cannot take ports:', error)
  process.exit(1)
}

// Settled once the socket listens: the host sees host:init only then, so it reports ready only
// when a port can connect, and what follows host:init waits behind it.
let listening: Promise<void> | null = null

const host = startAgentHost({
  send,
  onMessage: (listener) => {
    process.on('message', (data) => {
      const message = data as MainToHost
      if (message.type === 'host:init' && !listening) {
        const socketPath = message.socketPath
        if (!socketPath) fail(new Error('host:init names no socket'))
        listening = listenPorts(socketPath, (port) => host.connect(port)).then(
          () => listener(message),
          fail,
        )
      } else if (listening) {
        void listening.then(() => listener(message))
      } else {
        listener(message)
      }
    })
    // Without the process that started it, nothing can reach the host any more.
    process.on('disconnect', () => listener({ type: 'host:shutdown' }))
  },
})
