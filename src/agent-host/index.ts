// Entry of the agent host utility process: main's messages in, the host's messages out.

import { Worker } from 'node:worker_threads'
import type { MessagePortMain } from 'electron'
import type { AttachmentGrant } from '@shared/attachments'
import type { HostToMain, MainToHost } from '@shared/host-control'
import { createGitService } from './git'
import { AgentHost } from './host'
import type { PortChannel } from './rpc'
import { nodeThreadWorker } from './threads/store'
import { nodeUsageWorker } from './usage/store'

const parentPort = process.parentPort

function send(message: HostToMain): void {
  parentPort.postMessage(message)
}

function channel(port: MessagePortMain): PortChannel {
  return {
    send: (message) => port.postMessage(message),
    onMessage: (listener) => port.on('message', (event) => listener(event.data)),
    onClose: (listener) => port.on('close', listener),
    close: () => port.close(),
  }
}

let host: Promise<AgentHost> | null = null

function isGrant(value: unknown): value is AttachmentGrant {
  if (typeof value !== 'object' || value === null) return false
  const { grantId, path, kind } = value as Record<string, unknown>
  return (
    typeof grantId === 'string' &&
    typeof path === 'string' &&
    (kind === 'file' || kind === 'folder')
  )
}

function init(message: Extract<MainToHost, { type: 'host:init' }>): void {
  if (host) {
    send({ type: 'host:log', level: 'warn', message: 'host:init arrived twice; ignored' })
    return
  }
  host = AgentHost.start({
    userDataPath: message.userDataPath,
    appVersion: message.appVersion,
    platform: message.platform,
    electronPath: message.electronPath,
    fakeAgentPath: message.fakeAgentPath,
    sessionRouterPath: message.sessionRouterPath,
    settings: message.settings,
    baseEnv: process.env,
    send,
    git: (deps) => createGitService(deps),
    mirrorTraffic: !message.isPackaged && process.env.OVERBENCH_ACP_LOG === '1',
    threadWorker: (data) =>
      nodeThreadWorker(new Worker(message.threadWorkerPath, { workerData: data })),
    usageWorker: (file) =>
      nodeUsageWorker(new Worker(message.usageWorkerPath, { workerData: { file } })),
  })
  host.catch((error: unknown) => {
    // Without its state the host cannot run; main restarts it with backoff.
    console.error('Agent host failed to start:', error)
    process.exit(1)
  })
}

function withHost(run: (host: AgentHost) => unknown): void {
  if (!host) {
    send({ type: 'host:log', level: 'warn', message: 'A message arrived before host:init' })
    return
  }
  void host.then(run)
}

process.on('unhandledRejection', (reason) => {
  const message = `Unhandled rejection: ${(reason as Error)?.stack ?? String(reason)}`
  console.error(message)
  send({ type: 'host:log', level: 'error', message })
})

parentPort.on('message', ({ data, ports }) => {
  const message = data as MainToHost
  switch (message.type) {
    case 'host:init':
      init(message)
      break
    case 'host:connect': {
      const port = ports[0]
      if (!port) break
      withHost((h) => {
        h.connect(channel(port))
        port.start()
      })
      break
    }
    case 'host:settings':
      withHost((h) => h.updateSettings(message.settings))
      break
    case 'host:busy-request':
      withHost((h) => h.busy(message.requestId))
      break
    case 'host:grant':
      if (Array.isArray(message.grants)) {
        withHost((h) => h.grant(message.requestId, message.grants.filter(isGrant)))
      }
      break
    case 'host:artifact-content-request':
      withHost((h) => h.artifactContent(message.requestId, message.id, message.version))
      break
    case 'host:artifact-list-request':
      withHost((h) => h.artifactList(message.requestId))
      break
    case 'host:artifact-import-request':
      withHost((h) => h.artifactImport(message.requestId, message.path, message.project))
      break
    case 'host:power':
      withHost((h) => h.power(message.state))
      break
    case 'host:shutdown':
      if (!host) {
        send({ type: 'host:stopped' })
        process.exit(0)
      }
      withHost(async (h) => {
        await h.shutdown()
        // Lets host:stopped leave before the process ends.
        setImmediate(() => process.exit(0))
      })
      break
  }
})
