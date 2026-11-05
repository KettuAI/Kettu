// The device host's process, whatever runs it: main's messages in over the control channel, the
// host's out, and each client's port as it connects. index.ts runs it in Electron's utility
// process, node-main.ts under Node.js.

import type { DeviceCall, DeviceCallAnswer, DeviceCallErrorCode } from '@shared/device-agent'
import type { DeviceEvent } from '@shared/device-host'
import type { DeviceHostToMain, MainToDeviceHost } from '@shared/host-control'
import { writeLog } from '@shared/log/process-log'
import type { ControlChannel, PortChannel } from '@shared/port-channel'
import type { FromPort } from '@shared/port-rpc'
import type { PortDevice } from '@shared/remote/device'
import type { Env } from '../agent-host/find-command'
import { resolveShellEnvironment } from '../agent-host/shell-env'
import { ActionError, AgentActions } from './agent'
import { DeviceError, DeviceManager } from './devices'
import { PortServer } from './server'

/** The bar that names the agent stays this long after its last call. */
const OPERATOR_LINGER_MS = 5_000

export interface StartedDeviceHost {
  connect(
    port: PortChannel<FromPort<DeviceEvent>>,
    windowId: number,
    device?: PortDevice | null,
  ): void
}

function warn(message: string): void {
  writeLog('warn', 'host', message)
}

export function startDeviceHost(
  control: ControlChannel<MainToDeviceHost, DeviceHostToMain>,
): StartedDeviceHost {
  const send = (message: DeviceHostToMain): void => control.send(message)
  let server: PortServer | null = null
  let manager: DeviceManager | null = null
  let actions: AgentActions | null = null
  const running = new Map<string, AbortController>()
  const lingering = new Map<string, ReturnType<typeof setTimeout>>()

  function init(message: Extract<MainToDeviceHost, { type: 'device-host:init' }>): void {
    let env: Promise<Env> | null = null
    const loadEnv = (): Promise<Env> => {
      env ??= resolveShellEnvironment({
        platform: message.platform,
        nodeRuntime: message.nodeRuntime,
        baseEnv: process.env,
      }).then((resolved) => resolved.env)
      return env
    }
    manager = new DeviceManager({
      platform: message.platform,
      dataDir: message.dataDir,
      env: loadEnv,
      resourcesPath: message.resourcesPath,
      emit: (port, event) => (port ? server?.send(port, event) : server?.broadcast(event)),
      log: (line) => console.log(line),
    })
    const devices = manager
    actions = new AgentActions(message.dataDir, loadEnv, (line) => console.log(line))
    server = new PortServer(
      {
        'devices.environment': () => devices.environment(),
        'devices.list': () => devices.list(),
        'devices.open': (_, params) => devices.open(params.deviceId, params.sessionId),
        'devices.close': (_, params) =>
          devices.close(params.deviceId, params.sessionId, params.shutdown === true),
        'devices.watch': (port, params) => devices.watch(port, params.deviceId),
        'devices.unwatch': (port, params) => devices.unwatch(port, params.deviceId),
        'devices.ack': (port, params) => devices.ack(port, params.deviceId, params.seq),
        'devices.input': (_, params) => devices.input(params.deviceId, params.input),
        'devices.handBack': (_, params) => devices.handBack(params.deviceId),
        'devices.stopAgent': (_, params) => {
          running.get(params.deviceId)?.abort()
          devices.setOperator(params.deviceId, { sessionId: null, agentName: null, user: true })
        },
        'devices.screenshot': async (_, params) => {
          const png = await devices.screenshot(params.deviceId)
          return { png: png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) }
        },
      },
      () => devices.setPolling(true),
      (port) => {
        devices.portClosed(port)
        if (server?.size === 0) devices.setPolling(false)
      },
      warn,
    )
    server.setAllowDevices(message.allowDevices)
    send({ type: 'device-host:ready' })
  }

  async function call(request: DeviceCall): Promise<DeviceCallAnswer> {
    const devices = manager
    const agent = actions
    if (!devices || !agent) return failure('unavailable', 'The device host has not started')
    try {
      if (request.kind === 'list') {
        const list = await devices.list()
        const lines = list.map((device) => {
          const held =
            device.sessionId === request.sessionId
              ? ', open in this session'
              : device.sessionId
                ? ', in use by another session'
                : ''
          const problems = device.problems.length ? `, needs: ${device.problems.join(', ')}` : ''
          return `- ${device.id}: ${device.name} (${device.platform} ${device.kind}${device.osVersion ? ` ${device.osVersion}` : ''}, ${device.state}${held}${problems})`
        })
        return {
          result: {
            text: lines.length
              ? lines.join('\n')
              : 'No simulators, emulators or devices were found on this host.',
            value: { devices: list },
          },
        }
      }
      if (request.kind === 'open') {
        const info = await devices.open(request.deviceId, request.sessionId)
        server?.broadcast({
          type: 'device.opened',
          deviceId: info.id,
          sessionId: request.sessionId,
        })
        return {
          result: {
            text: `Opened ${info.name} (${info.id}). It is shown beside the session.`,
            value: { device: info },
          },
        }
      }
      if (request.kind === 'close') {
        await devices.close(request.deviceId, request.sessionId, request.shutdown)
        return { result: { text: 'Closed.' } }
      }
      const target = devices.target(request.deviceId)
      if (!target)
        return failure('not_found', 'No such device on this host. List the devices first.')
      if (devices.holder(request.deviceId) !== request.sessionId) {
        return failure('not_open', 'Open the device in this session with device_open first.')
      }
      const operator = devices.operator(request.deviceId)
      if (operator?.user) {
        return failure(
          'user_has_control',
          'The user is operating this device. Wait until they hand it back.',
        )
      }
      if (running.has(request.deviceId))
        return failure('busy', 'Another action is running on this device.')
      const controller = new AbortController()
      running.set(request.deviceId, controller)
      clearTimeout(lingering.get(request.deviceId))
      devices.setOperator(request.deviceId, {
        sessionId: request.sessionId,
        agentName: request.agentName,
        user: false,
      })
      try {
        const action = request.action
        if (action.type === 'install' && request.projectPath && !action.path.startsWith('/')) {
          action.path = `${request.projectPath}/${action.path}`
        }
        return { result: await agent.run(request.sessionId, target, action, controller.signal) }
      } finally {
        running.delete(request.deviceId)
        lingering.set(
          request.deviceId,
          setTimeout(() => {
            lingering.delete(request.deviceId)
            const current = devices.operator(request.deviceId)
            if (current && !current.user) devices.setOperator(request.deviceId, null)
          }, OPERATOR_LINGER_MS),
        )
      }
    } catch (error) {
      if (error instanceof ActionError) {
        return failure(error.code === 'stopped' ? 'stopped' : 'failed', error.message)
      }
      if (error instanceof DeviceError) {
        const code: DeviceCallErrorCode =
          error.code === 'busy' ? 'busy' : error.code === 'not_found' ? 'not_found' : 'unavailable'
        return failure(code, error.message, error.data)
      }
      return failure('failed', error instanceof Error ? error.message : String(error))
    }
  }

  control.onMessage((message) => {
    switch (message?.type) {
      case 'device-host:init':
        if (!manager) init(message)
        break
      case 'device-host:allow-devices':
        server?.setAllowDevices(message.allowed)
        break
      case 'device-host:sessions-ended': {
        manager?.endSessions(message.sessionIds)
        break
      }
      case 'device-host:call':
        void call(message.call).then((answer) =>
          send({ type: 'device-host:answer', callId: message.callId, answer }),
        )
        break
      case 'device-host:shutdown':
        void (manager?.dispose() ?? Promise.resolve()).finally(() => {
          server?.closeAll()
          send({ type: 'device-host:stopped' })
          process.exit(0)
        })
    }
  })

  return {
    connect: (port, windowId, device = null) => {
      if (server) server.attach(port, windowId, device)
      else port.close()
    },
  }
}

function failure(code: DeviceCallErrorCode, message: string, data?: unknown): DeviceCallAnswer {
  return { error: { code, message, ...(data !== undefined ? { data } : {}) } }
}
