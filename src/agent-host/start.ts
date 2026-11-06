// The agent host's process, whatever runs it: main's messages in over the control channel, the
// host's out, and each client's port as it connects. index.ts runs it in Electron's utility
// process, node-main.ts under Node.js.

import { Worker } from 'node:worker_threads'
import type { HostEvent } from '@shared/agent-host'
import { setLogLevel, writeLog } from '@shared/log/process-log'
import { ARTIFACT_ID } from '@shared/artifacts'
import type { AttachmentGrant } from '@shared/attachments'
import type { HostToMain, MainToHost } from '@shared/host-control'
import type { ControlChannel, PortChannel } from '@shared/port-channel'
import type { FromPort } from '@shared/port-rpc'
import type { PortDevice } from '@shared/remote/device'
import { createGitService } from './git'
import { AgentHost } from './host'
import { nodeThreadWorker } from './threads/store'
import { nodeUsageWorker } from './usage/store'

export interface StartedAgentHost {
  /**
   * A window's port, or a paired device's when `device` names it; it is served once the host has
   * started, and closed if it never was.
   */
  connect(port: PortChannel<FromPort<HostEvent>>, device: PortDevice | null): void
}

function isGrant(value: unknown): value is AttachmentGrant {
  if (typeof value !== 'object' || value === null) return false
  const { grantId, path, kind } = value as Record<string, unknown>
  return (
    typeof grantId === 'string' &&
    typeof path === 'string' &&
    (kind === 'file' || kind === 'folder')
  )
}

function isHostDecision(value: unknown): value is 'session' | 'project' | 'deny' | 'timeout' {
  return value === 'session' || value === 'project' || value === 'deny' || value === 'timeout'
}

export function startAgentHost(control: ControlChannel<MainToHost, HostToMain>): StartedAgentHost {
  const send = (message: HostToMain): void => control.send(message)
  let host: Promise<AgentHost> | null = null

  function init(message: Extract<MainToHost, { type: 'host:init' }>): void {
    if (host) {
      writeLog('warn', 'host', 'host:init arrived twice; ignored')
      return
    }
    host = AgentHost.start({
      userDataPath: message.userDataPath,
      appVersion: message.appVersion,
      platform: message.platform,
      nodeRuntime: message.nodeRuntime,
      fakeAgentPath: message.fakeAgentPath,
      sessionRouterPath: message.sessionRouterPath,
      settings: message.settings,
      baseEnv: process.env,
      computer: message.computer ?? null,
      send,
      git: (deps) => createGitService(deps),
      mirrorTraffic: !message.isPackaged && process.env.KETTU_ACP_LOG === '1',
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

  function withHost(run: (host: AgentHost) => unknown): boolean {
    if (!host) {
      writeLog('warn', 'host', 'A message arrived before host:init')
      return false
    }
    void host.then(run)
    return true
  }

  // A rejection must not end the host, which serves every session.
  process.on('unhandledRejection', (reason) => {
    writeLog('error', 'host', `Unhandled rejection: ${(reason as Error)?.stack ?? String(reason)}`)
  })

  control.onMessage((message) => {
    switch (message.type) {
      case 'host:init':
        init(message)
        break
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
      case 'host:artifact-runtime':
        if (
          Number.isSafeInteger(message.requestId) &&
          ARTIFACT_ID.test(String(message.artifactId))
        ) {
          withHost((h) => h.artifactRuntime(message.requestId, message.artifactId, message.message))
        }
        break
      case 'host:artifact-runtime-cancel':
        if (Number.isSafeInteger(message.requestId)) {
          withHost((h) => h.artifactRuntimeCancel(message.requestId))
        }
        break
      case 'host:artifact-export-request':
        withHost((h) =>
          h.artifactExport(message.requestId, message.id, message.version, message.format),
        )
        break
      case 'browser-result':
        if (Number.isSafeInteger(message.callId)) {
          withHost((h) => h.browserResult(message.callId, message.result, message.error))
        }
        break
      case 'device-result':
        if (Number.isSafeInteger(message.callId) && typeof message.answer === 'object') {
          withHost((h) => h.deviceResult(message.callId, message.answer))
        }
        break
      case 'host:browser-waiting':
        if (Number.isSafeInteger(message.callId) && typeof message.waiting === 'boolean') {
          withHost((h) => h.browserWaiting(message.callId, message.waiting))
        }
        break
      case 'host:browser-origin-ask':
        if (Number.isSafeInteger(message.requestId)) {
          withHost((h) =>
            h.browserOriginAsked(message.requestId, message.sessionId, message.origin),
          )
        }
        break
      case 'host:browser-origin-answer':
        if (Number.isSafeInteger(message.requestId) && isHostDecision(message.decision)) {
          withHost((h) => h.browserOriginSettled(message.requestId, message.decision))
        }
        break
      case 'host:power':
        withHost((h) => h.power(message.state))
        break
      case 'host:log-level':
        if (message.level === 'debug' || message.level === 'info') setLogLevel(message.level)
        break
      case 'host:permission-answer':
        if (
          typeof message.sessionId === 'string' &&
          typeof message.requestId === 'string' &&
          typeof message.optionId === 'string'
        ) {
          withHost((h) =>
            h.answerPermission(message.sessionId, message.requestId, message.optionId),
          )
        }
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

  return {
    connect: (port, device) => {
      if (!withHost((h) => h.connect(port, device))) port.close()
    },
  }
}
