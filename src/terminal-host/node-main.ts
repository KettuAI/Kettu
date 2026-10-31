// Entry of the terminal host under Node.js, started with `child_process.fork`: control messages
// over its IPC, and each port as a connection to the local socket that `terminal-host:init` names.

import type { MainToTerminalHost, TerminalHostToMain } from '@shared/host-control'
import { listenPorts } from '@shared/socket-port'
import { startTerminalHost } from './start'

// A port from the socket comes from no window, which main writes as -1.
const NO_WINDOW = -1

function send(message: TerminalHostToMain): void {
  if (process.connected) process.send!(message)
}

function fail(error: unknown): never {
  console.error('Terminal host cannot take ports:', error)
  process.exit(1)
}

// Settled once the socket listens: the host sees terminal-host:init only then, so it reports
// ready only when a port can connect, and what follows the init waits behind it.
let listening: Promise<void> | null = null

const host = startTerminalHost({
  send,
  onMessage: (listener) => {
    process.on('message', (data) => {
      const message = data as MainToTerminalHost
      if (message?.type === 'terminal-host:init' && !listening) {
        const socketPath = message.socketPath
        if (!socketPath) fail(new Error('terminal-host:init names no socket'))
        listening = listenPorts(socketPath, (port) => host.connect(port, NO_WINDOW)).then(
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
    process.on('disconnect', () => listener({ type: 'terminal-host:shutdown' }))
  },
})
