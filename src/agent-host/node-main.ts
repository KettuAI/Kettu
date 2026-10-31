// Entry of the agent host under Node.js, started with `child_process.fork`: control messages over
// its IPC, and each port as a connection to the local socket that `host:init` names.

import type { HostToMain, MainToHost } from '@shared/host-control'
import type { PortChannel } from '@shared/port-channel'
import { parsePortDevice, type PortDevice } from '@shared/remote/device'
import { listenPorts } from '@shared/socket-port'
import { startAgentHost } from './start'

function send(message: HostToMain): void {
  if (process.connected) process.send!(message)
}

function fail(error: unknown): never {
  console.error('Agent host cannot take ports:', error)
  process.exit(1)
}

/**
 * Reads who a port serves from its first message: a paired device's port starts with the
 * `host:connect` that names it, as main sends it in the desktop app; any other first message is a
 * window's first request, which the port still carries.
 */
function identify(
  port: PortChannel,
  connect: (port: PortChannel, device: PortDevice | null) => void,
): void {
  let identified = false
  let listener: ((data: unknown) => void) | null = null
  const waiting: unknown[] = []
  const rest: PortChannel = {
    send: (message) => port.send(message),
    onMessage: (next) => {
      listener = next
      for (const message of waiting.splice(0)) next(message)
    },
    onClose: (next) => port.onClose(next),
    close: () => port.close(),
  }
  port.onMessage((data) => {
    if (identified) {
      if (listener) listener(data)
      else waiting.push(data)
      return
    }
    identified = true
    if ((data as { type?: unknown } | null)?.type !== 'host:connect') {
      waiting.push(data)
      return connect(rest, null)
    }
    // A device's port that does not name one validly is never served as a window's.
    const device = parsePortDevice((data as { device?: unknown }).device)
    if (device) connect(rest, device)
    else port.close()
  })
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
        listening = listenPorts(socketPath, (port) =>
          identify(port, (rest, device) => host.connect(rest, device)),
        ).then(() => listener(message), fail)
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
