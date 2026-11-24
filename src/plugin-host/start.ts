// The plugin host's process, whatever runs it: the control channel of the process that started
// it, and the agent host's port. index.ts runs it in Electron's utility process, node-main.ts
// under Node.js.

import { readFile } from 'node:fs/promises'
import { writeLog } from '@shared/log/process-log'
import {
  isPluginId,
  isPluginScript,
  PLUGIN_ANSWER_TIMEOUT_MS,
  PluginRequestError,
  type AgentToPluginHost,
  type MainToPluginHost,
  type PluginError,
  type PluginHostToAgent,
  type PluginHostToMain,
} from '@shared/plugin-host'
import type { ControlChannel, PortChannel } from '@shared/port-channel'
import type { LogLevel } from '@shared/log/process-log'
import { loadEngine, type Engine } from './engine'
import type { EnvironmentLimits } from './environment'
import { HOST_FUNCTIONS } from './host-functions'
import { PluginManager } from './plugins'

export interface StartedPluginHost {
  /** The agent host's port, which replaces the one before it. */
  connect(port: PortChannel<PluginHostToAgent>): void
}

interface Forwarded {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

function asError(error: unknown): PluginError {
  if (error instanceof PluginRequestError) return { code: error.code, message: error.message }
  return { code: 'failed', message: error instanceof Error ? error.message : String(error) }
}

/** Serves the agent host's requests on `port` from `manager`. */
function servePort(
  port: PortChannel<PluginHostToAgent>,
  manager: PluginManager,
  answerFunction: (callId: number, answer: { result: unknown } | { error: PluginError }) => void,
): void {
  const answer = (requestId: number, run: () => unknown): void => {
    Promise.resolve()
      .then(run)
      .then(
        (result) => port.send({ type: 'answer', requestId, result: result ?? null }),
        (error: unknown) => port.send({ type: 'answer', requestId, error: asError(error) }),
      )
  }
  const invalid = (what: string): never => {
    throw new PluginRequestError({ code: 'invalid', message: what })
  }
  port.onMessage((data) => {
    if (typeof data !== 'object' || data === null) return
    const message = data as AgentToPluginHost
    if (message.type === 'restore') {
      if (Array.isArray(message.disabled)) manager.restore(message.disabled)
      return
    }
    if (message.type === 'function-result') {
      if (!Number.isSafeInteger(message.callId)) return
      answerFunction(
        message.callId,
        'error' in message
          ? { error: { code: 'failed', message: String(message.error?.message ?? 'It failed') } }
          : { result: message.result },
      )
      return
    }
    const { requestId } = message
    if (!Number.isSafeInteger(requestId)) return
    answer(requestId, () => {
      switch (message.type) {
        case 'activate':
          if (!isPluginScript(message.plugin) || typeof message.trigger !== 'string') {
            return invalid('The plugin or what wakes it is not valid')
          }
          return manager.activate(message.plugin, message.trigger)
        case 'call':
          if (
            !isPluginId(message.pluginId) ||
            typeof message.name !== 'string' ||
            !Array.isArray(message.args)
          ) {
            return invalid('The call is not valid')
          }
          return manager.call(
            message.pluginId,
            message.name,
            message.args,
            message.deadline === 'before-send' ? 'before-send' : 'call',
          )
        case 'event':
          if (!isPluginId(message.pluginId) || typeof message.name !== 'string') {
            return invalid('The event is not valid')
          }
          return manager.event(message.pluginId, message.name, message.payload)
        case 'hook':
          if (!isPluginId(message.pluginId) || typeof message.name !== 'string') {
            return invalid('The hook is not valid')
          }
          return manager.hook(
            message.pluginId,
            message.name,
            message.payload,
            message.deadline === 'call' ? 'call' : 'before-send',
          )
        case 'deactivate':
          if (!isPluginId(message.pluginId)) return invalid('The plugin is not valid')
          return manager.deactivate(message.pluginId)
        case 'enable':
          if (!isPluginId(message.pluginId)) return invalid('The plugin is not valid')
          return manager.enable(message.pluginId)
        default:
          return invalid('Unknown request')
      }
    })
  })
}

export interface PluginServiceOptions {
  engine: Engine
  readScript(scriptPath: string): Promise<string>
  log(pluginId: string, level: LogLevel, text: string): void
  limits?: Partial<EnvironmentLimits>
}

export interface PluginService {
  /** The agent host's port, which replaces the one before it. */
  connect(port: PortChannel<PluginHostToAgent>): void
  /** Unloads every plugin and closes the port. */
  stop(): void
}

/** The plugins and the one port they are reached through. */
export function createPluginService(options: PluginServiceOptions): PluginService {
  let port: PortChannel<PluginHostToAgent> | null = null
  const forwarded = new Map<number, Forwarded>()
  let nextForward = 1

  function dropForwarded(): void {
    for (const [callId, call] of forwarded) {
      forwarded.delete(callId)
      clearTimeout(call.timer)
      call.reject(new Error('The host function cannot be reached'))
    }
  }

  const manager = new PluginManager({
    engine: options.engine,
    functions: HOST_FUNCTIONS,
    forward: (pluginId, name, args) => {
      const to = port
      if (!to) return Promise.reject(new Error('The host function cannot be reached'))
      return new Promise((resolve, reject) => {
        const callId = nextForward++
        const timer = setTimeout(() => {
          forwarded.delete(callId)
          reject(new Error(`"${name}" did not answer`))
        }, PLUGIN_ANSWER_TIMEOUT_MS)
        forwarded.set(callId, { resolve, reject, timer })
        to.send({ type: 'function-call', callId, pluginId, name, args })
      })
    },
    readScript: options.readScript,
    log: options.log,
    onStatus: (plugins) => port?.send({ type: 'status', plugins }),
    ...(options.limits ? { limits: options.limits } : {}),
  })

  return {
    connect: (next) => {
      // A new port is a new agent host, which knows nothing of what the last one loaded.
      port?.close()
      manager.clear()
      dropForwarded()
      port = next
      next.onClose(() => {
        if (port !== next) return
        port = null
        manager.clear()
        dropForwarded()
      })
      servePort(next, manager, (callId, answer) => {
        const call = forwarded.get(callId)
        if (!call) return
        forwarded.delete(callId)
        clearTimeout(call.timer)
        if ('error' in answer) call.reject(new Error(answer.error.message))
        else call.resolve(answer.result)
      })
    },
    stop: () => {
      manager.clear()
      dropForwarded()
      port?.close()
      port = null
    },
  }
}

export function startPluginHost(
  control: ControlChannel<MainToPluginHost, PluginHostToMain>,
): StartedPluginHost {
  let service: PluginService | null = null
  let starting = false
  let waiting: PortChannel<PluginHostToAgent> | null = null

  async function init(message: Extract<MainToPluginHost, { type: 'plugin-host:init' }>) {
    const engine = await loadEngine(new Uint8Array(await readFile(message.wasmPath)))
    service = createPluginService({
      engine,
      readScript: (scriptPath) => readFile(scriptPath, 'utf8'),
      log: (pluginId, level, text) => writeLog(level, `plugin:${pluginId}`, text),
    })
    if (waiting) service.connect(waiting)
    waiting = null
    control.send({ type: 'plugin-host:ready' })
  }

  control.onMessage((message) => {
    switch (message.type) {
      case 'plugin-host:init':
        if (starting) return
        starting = true
        init(message).catch((error: unknown) => {
          // Without its engine the host cannot run; the process that started it restarts it.
          console.error('Plugin host failed to start:', error)
          process.exit(1)
        })
        break
      case 'plugin-host:ping':
        control.send({ type: 'plugin-host:pong', id: message.id })
        break
      case 'plugin-host:shutdown':
        service?.stop()
        control.send({ type: 'plugin-host:stopped' })
        // Lets plugin-host:stopped leave before the process ends.
        setImmediate(() => process.exit(0))
        break
    }
  })

  return {
    connect: (next) => {
      if (service) service.connect(next)
      else {
        waiting?.close()
        waiting = next
      }
    },
  }
}
