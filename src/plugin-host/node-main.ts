// Entry of the plugin host under Node.js, started with `child_process.fork`: control messages
// over its IPC, and the agent host's port as a connection to the local socket that
// `plugin-host:init` names.

import { startHostInspector } from '@shared/log/debug-inspector'
import { startHostLog } from '@shared/log/process-log'
import type { MainToPluginHost, PluginHostToMain } from '@shared/plugin-host'
import { listenPorts } from '@shared/socket-port'
import { startPluginHost } from './start'

startHostLog('plugin-host')
startHostInspector()

function send(message: PluginHostToMain): void {
  if (process.connected) process.send!(message)
}

function fail(error: unknown): never {
  console.error('Plugin host cannot take its port:', error)
  process.exit(1)
}

// Settled once the socket listens: the host sees plugin-host:init only then, so it reports
// ready only when the agent host can connect, and what follows the init waits behind it.
let listening: Promise<void> | null = null

const host = startPluginHost({
  send,
  onMessage: (listener) => {
    process.on('message', (data) => {
      const message = data as MainToPluginHost
      if (message?.type === 'plugin-host:init' && !listening) {
        const socketPath = message.socketPath
        if (!socketPath) fail(new Error('plugin-host:init names no socket'))
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
    process.on('disconnect', () => listener({ type: 'plugin-host:shutdown' }))
  },
})
