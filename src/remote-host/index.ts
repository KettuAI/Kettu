// Entry of the remote host utility process: Electron's parent port adapted to the host's control
// channel, and the agent host's ports that main hands over as MessagePorts. The only file of the
// host that uses Electron.

import type { MessagePortMain } from 'electron'
import type { MainToRemoteHost, RemoteHostToMain } from '@shared/host-control'
import type { PortChannel } from '@shared/port-channel'
import { startRemoteHost } from './start'

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

const waiting = new Map<number, (port: PortChannel | null) => void>()
let nextRequest = 1

startRemoteHost(
  {
    send: (message) => parentPort.postMessage(message),
    onMessage: (listener) =>
      parentPort.on('message', ({ data, ports }) => {
        const message = data as MainToRemoteHost
        if (message?.type !== 'remote-host:port') return listener(message)
        const resolve = waiting.get(message.requestId)
        waiting.delete(message.requestId)
        const port = ports[0]
        if (resolve) resolve(port ? channel(port) : null)
        else port?.close()
      }),
  },
  {
    openAgentPort: (device) =>
      new Promise((resolve) => {
        const requestId = nextRequest++
        waiting.set(requestId, resolve)
        const request: RemoteHostToMain = { type: 'remote-host:open-port', requestId, device }
        parentPort.postMessage(request)
      }),
  },
)
