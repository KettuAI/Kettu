// Entry of the device host under Node.js, started with `child_process.fork`: control messages
// over its IPC, and each port as a connection to the local socket that `device-host:init` names,
// a paired device's starting with the `device-host:connect` that names it.

import { startHostLog } from '@shared/log/process-log'
import type { MainToDeviceHost, DeviceHostToMain } from '@shared/host-control'
import { identifyPort } from '@shared/remote/device'
import { listenPorts } from '@shared/socket-port'
import { startDeviceHost } from './start'

startHostLog('device-host')

// A port from the socket comes from no window, which main writes as -1.
const NO_WINDOW = -1

function send(message: DeviceHostToMain): void {
  if (process.connected) process.send!(message)
}

function fail(error: unknown): never {
  console.error('Device host cannot take ports:', error)
  process.exit(1)
}

// Settled once the socket listens: the host sees device-host:init only then, so it reports
// ready only when a port can connect, and what follows the init waits behind it.
let listening: Promise<void> | null = null

const host = startDeviceHost({
  send,
  onMessage: (listener) => {
    process.on('message', (data) => {
      const message = data as MainToDeviceHost
      if (message?.type === 'device-host:init' && !listening) {
        const socketPath = message.socketPath
        if (!socketPath) fail(new Error('device-host:init names no socket'))
        listening = listenPorts(socketPath, (port) =>
          identifyPort(port, 'device-host:connect', (rest, device) =>
            host.connect(rest, NO_WINDOW, device),
          ),
        ).then(() => listener(message), fail)
      } else if (listening) {
        void listening.then(() => listener(message))
      } else {
        listener(message)
      }
    })
    // Without the process that started it, nothing can reach the host any more.
    process.on('disconnect', () => listener({ type: 'device-host:shutdown' }))
  },
})
