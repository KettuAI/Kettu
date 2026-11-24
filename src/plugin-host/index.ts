// Entry of the plugin host utility process: Electron's parent port and the agent host's
// MessagePort adapted to the host's channels. The only file of the host that uses Electron.

import { startHostInspector } from '@shared/log/debug-inspector'
import { startHostLog } from '@shared/log/process-log'
import type { MessagePortMain } from 'electron'
import type { MainToPluginHost, PluginHostToAgent } from '@shared/plugin-host'
import type { PortChannel } from '@shared/port-channel'
import { startPluginHost } from './start'

startHostLog('plugin-host')
startHostInspector()

const parentPort = process.parentPort

function channel(port: MessagePortMain): PortChannel<PluginHostToAgent> {
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

const host = startPluginHost({
  send: (message) => parentPort.postMessage(message),
  onMessage: (listener) =>
    parentPort.on('message', ({ data, ports }) => {
      const message = data as MainToPluginHost
      if (message?.type !== 'plugin-host:connect') return listener(message)
      const port = ports[0]
      if (port) host.connect(channel(port))
    }),
})
