// Entry of the agent host utility process: Electron's parent port and MessagePorts adapted to the
// host's channels. The only file of the host that uses Electron.

import type { MessagePortMain } from 'electron'
import type { MainToHost } from '@shared/host-control'
import type { PortChannel } from '@shared/port-channel'
import { startAgentHost } from './start'

const parentPort = process.parentPort

function channel(port: MessagePortMain): PortChannel {
  return {
    send: (message) => port.postMessage(message),
    // The port queues what arrives until it starts, so nothing is lost before the listener.
    onMessage: (listener) => {
      port.on('message', (event) => listener(event.data))
      port.start()
    },
    onClose: (listener) => port.on('close', listener),
    close: () => port.close(),
  }
}

const host = startAgentHost({
  send: (message) => parentPort.postMessage(message),
  onMessage: (listener) =>
    parentPort.on('message', ({ data, ports }) => {
      const message = data as MainToHost
      if (message.type !== 'host:connect') return listener(message)
      const port = ports[0]
      if (port) host.connect(channel(port))
    }),
})
