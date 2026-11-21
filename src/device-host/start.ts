// The device host's process, whatever runs it: main's messages in over the control channel, the
// host's out, and each client's port as it connects. index.ts runs it in Electron's utility
// process, node-main.ts under Node.js.

import { CONTROL_WAIT_MS, ControlWait } from '@shared/control'
import type {
  DeviceAction,
  DeviceCall,
  DeviceCallAnswer,
  DeviceCallErrorCode,
} from '@shared/device-agent'
import type { DeviceEvent } from '@shared/device-host'
import type { DeviceHostToMain, MainToDeviceHost } from '@shared/host-control'
import { setLocale, t } from '@shared/hosts-text'
import { isLocale } from '@shared/locale'
import { writeLog } from '@shared/log/process-log'
import type { ControlChannel, PortChannel } from '@shared/port-channel'
import type { FromPort } from '@shared/port-rpc'
import type { PortDevice } from '@shared/remote/device'
import type { Env } from '../agent-host/find-command'
import { resolveShellEnvironment } from '../agent-host/shell-env'
import { ActionError, AgentActions } from './agent'
import { DeviceError, DeviceManager } from './devices'
import { PortServer } from './server'

/** The point agent-device reports a tap by reference at, in the device's points. */
const TAPPED_AT = /^Tapped @\S+ \((-?[\d.]+), (-?[\d.]+)\)/m

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

  function init(message: Extract<MainToDeviceHost, { type: 'device-host:init' }>): void {
    if (isLocale(message.locale)) setLocale(message.locale)
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
      handedBack: (sessionId, durationMs) =>
        send({
          type: 'device-host:handed-back',
          sessionId,
          durationMs: Math.max(0, Math.round(durationMs)),
        }),
      log: (line) => console.log(line),
    })
    const devices = manager
    actions = new AgentActions(
      message.dataDir,
      loadEnv,
      () => devices.toolPaths(),
      (line) => console.log(line),
    )
    server = new PortServer(
      {
        'devices.environment': () => devices.environment(),
        'devices.list': () => devices.list(),
        'devices.open': (_, params) => devices.open(params.deviceId, params.sessionId),
        'devices.move': (_, params) => {
          // The other session's agent may be acting on it right now.
          running.get(params.deviceId)?.abort()
          return devices.move(params.deviceId, params.sessionId)
        },
        'devices.close': (_, params) =>
          devices.close(params.deviceId, params.sessionId, params.shutdown === true),
        'devices.shutdown': (_, params) => {
          running.get(params.deviceId)?.abort()
          return devices.shutdown(params.deviceId, params.sessionId)
        },
        'devices.watch': (port, params) => devices.watch(port, params.deviceId, params.sessionId),
        'devices.unwatch': (port, params) =>
          devices.unwatch(port, params.deviceId, params.sessionId),
        'devices.ack': (port, params) =>
          devices.ack(port, params.deviceId, params.seq, params.sessionId),
        'devices.input': (_, params) => {
          devices.input(params.deviceId, params.input, params.sessionId)
        },
        'devices.takeOver': (_, params) => {
          devices.takeOver(params.deviceId, params.sessionId)
        },
        'devices.stopAgent': (_, params) => {
          devices.takeOver(params.deviceId, params.sessionId)
        },
        'devices.handBack': (_, params) => {
          devices.handBack(params.deviceId, params.sessionId)
        },
        'devices.screenshot': async (_, params) => {
          const png = await devices.screenshot(params.deviceId, params.sessionId)
          return { png: png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) }
        },
        'devices.appearance': async (_, params) => ({
          appearance: await devices.appearance(params.deviceId, params.sessionId),
        }),
        'devices.setAppearance': (_, params) =>
          devices.setAppearance(params.deviceId, params.sessionId, params.appearance),
        'devices.frame': async (_, params) => ({
          frame: await devices.frame(params.deviceId, params.sessionId),
        }),
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
    if (!devices || !agent) return failure('unavailable', t('devices.starting'))
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
      // The turn uses the device from its first call; while the user holds it, the call waits,
      // returning before the harness's own limit for one tool call so the agent calls again.
      let end: () => void
      try {
        end = await devices.begin(
          request.deviceId,
          { sessionId: request.sessionId, agentName: request.agentName },
          { deadline: Date.now() + CONTROL_WAIT_MS },
        )
      } catch (error) {
        if (error instanceof ControlWait) return waitFailure(error)
        throw error
      }
      if (running.has(request.deviceId)) {
        end()
        return failure('busy', 'Another action is running on this device.')
      }
      const controller = new AbortController()
      running.set(request.deviceId, controller)
      try {
        const action = request.action
        if (action.type === 'install' && request.projectPath && !action.path.startsWith('/')) {
          action.path = `${request.projectPath}/${action.path}`
        }
        // A turn made through XCTest is invisible to the stream, which would keep drawing the
        // device upright; a device that streams is turned through its driver instead.
        if (
          action.type === 'rotate' &&
          (await devices.orient(request.deviceId, action.orientation))
        ) {
          devices.acted(request.deviceId, null)
          return { result: { text: `Rotated to ${action.orientation.replace(/_/g, '-')}` } }
        }
        const result = await agent.run(request.sessionId, target, action, controller.signal)
        void actedOn(devices, request.deviceId, action, result.text)
        return { result }
      } finally {
        running.delete(request.deviceId)
        end()
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
      case 'device-host:locale':
        if (isLocale(message.locale)) setLocale(message.locale)
        break
      case 'device-host:sessions-ended': {
        void manager
          ?.endSessions(message.sessionIds)
          .catch((error: unknown) => warn(`Cannot let go of ended sessions' devices: ${error}`))
        break
      }
      case 'device-host:turn-ended':
        if (typeof message.sessionId === 'string' || message.sessionId === null) {
          manager?.turnEnded(message.sessionId)
        }
        break
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

/** The agent acted on the device: where its watchers draw it, for an action they can see. */
async function actedOn(
  devices: DeviceManager,
  id: string,
  action: DeviceAction,
  text: string,
): Promise<void> {
  let point: { x: number; y: number } | null = null
  switch (action.type) {
    case 'tap':
      if ('x' in action) point = { x: action.x, y: action.y }
      else {
        const tapped = TAPPED_AT.exec(text)
        if (tapped) point = { x: Number(tapped[1]), y: Number(tapped[2]) }
      }
      break
    case 'swipe':
      point = action.from
      break
    case 'fill':
    case 'type':
    case 'scroll':
    case 'button':
    case 'launch':
    case 'terminate':
    case 'open_url':
      break
    default:
      // Reading the screen, logs or settings shows nothing on it.
      return
  }
  const at = point ? await devices.pointOnScreen(id, point.x, point.y).catch(() => null) : null
  devices.acted(id, at)
}

/** What a call that waited on the user says when it returns without acting. */
function waitFailure(wait: ControlWait): DeviceCallAnswer {
  switch (wait.reason) {
    case 'held':
    case 'asking':
      return failure(
        'user_has_control',
        'The user took over this device and still has it; call again to keep waiting.',
      )
    case 'stopped':
      return failure('stopped', 'The user stopped.')
    case 'gone':
      return failure('not_open', 'The device was closed or moved to another session.')
  }
}

function failure(code: DeviceCallErrorCode, message: string, data?: unknown): DeviceCallAnswer {
  return { error: { code, message, ...(data !== undefined ? { data } : {}) } }
}
