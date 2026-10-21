// Entry of the agent host utility process.

import type { MessagePortMain } from 'electron'
import type { HostToMain, MainToHost } from '@shared/host-control'
import type { FromPort, ToPort } from '@shared/port-rpc'

const parentPort = process.parentPort

function send(message: HostToMain): void {
  parentPort.postMessage(message)
}

function attach(port: MessagePortMain): void {
  port.on('message', ({ data }) => {
    const request = data as ToPort
    if (request?.type !== 'request') return
    const reply: FromPort<never> = {
      type: 'error',
      id: request.id,
      error: { code: 'unknown_method', message: `Unknown method "${request.method}"` },
    }
    port.postMessage(reply)
  })
  port.start()
}

parentPort.on('message', ({ data, ports }) => {
  const message = data as MainToHost
  switch (message.type) {
    case 'host:init':
      send({ type: 'host:ready' })
      break
    case 'host:connect':
      if (ports[0]) attach(ports[0])
      break
    case 'host:shutdown':
      send({ type: 'host:stopped' })
      process.exit(0)
      break
    case 'host:settings':
      break
    case 'host:busy-request':
      send({ type: 'host:busy', requestId: message.requestId, sessions: [] })
      break
  }
})
