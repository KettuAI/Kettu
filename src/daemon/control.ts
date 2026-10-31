// The control socket: how the CLI reaches the running daemon, which alone writes the host's state.
// It sits in the data folder, which only the user can open, and carries the envelope of the hosts'
// ports, framed as their sockets frame it.

import type { Server } from 'node:net'
import type { PortChannel } from '@shared/port-channel'
import { connectPort, listenPorts } from '@shared/socket-port'
import type { HostState } from './forked-host'

export type HostName = 'agent' | 'terminal'

export interface HostStatus {
  state: HostState
  pid: number | null
  /** How many times the daemon restarted it after it exited. */
  restarts: number
}

export interface DeviceSummary {
  id: string
  name: string
  platform: string
  connected: boolean
  lastConnectedAt: number | null
}

export interface DaemonStatus {
  version: string
  pid: number
  startedAt: number
  /** It got a signal to stop and is stopping its hosts. */
  stopping: boolean
  dataPath: string
  /** It runs as the service `kettu service install` set up, not in someone's terminal. */
  service: boolean
  key: {
    storage: 'file'
    path: string
    /** Whether only the user can read the file; null when it is missing. */
    private: boolean | null
  }
  hosts: Record<HostName, HostStatus>
  /** How many devices are connected, or null while remote access is not running. */
  connectedDevices: number | null
}

export interface ControlCalls {
  status: { params: undefined; result: DaemonStatus }
  /** A host's socket, for a port of its own; the terminal host starts on the first ask. */
  'host.socket': { params: { host: HostName }; result: { path: string } }
  'devices.list': { params: undefined; result: DeviceSummary[] }
  'devices.remove': { params: { id: string }; result: null }
}

export type ControlMethod = keyof ControlCalls
type Params<M extends ControlMethod> = ControlCalls[M]['params']
type Result<M extends ControlMethod> = ControlCalls[M]['result']

export type ControlErrorCode =
  'unknown_method' | 'invalid_params' | 'not_found' | 'unavailable' | 'internal'

export class ControlError extends Error {
  constructor(
    readonly code: ControlErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ControlError'
  }
}

/** No daemon listens on the control socket. */
export class NotRunning extends Error {
  constructor() {
    super('The daemon is not running')
    this.name = 'NotRunning'
  }
}

type Request = { type: 'request'; id: number; method: string; params: unknown }
type Reply =
  | { type: 'response'; id: number; result: unknown }
  | { type: 'error'; id: number; error: { code: ControlErrorCode; message: string } }

export type ControlHandlers = {
  [M in ControlMethod]: (params: Params<M>) => Promise<Result<M>>
}

const MAX_ID = 256
const CLOSE_WAIT_MS = 2000

function none(raw: unknown): undefined {
  if (raw !== undefined && raw !== null) throw new ControlError('invalid_params', 'Takes no params')
  return undefined
}

function record(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ControlError('invalid_params', 'Params must be an object')
  }
  return raw as Record<string, unknown>
}

const validators: { [M in ControlMethod]: (raw: unknown) => Params<M> } = {
  status: none,
  'host.socket': (raw) => {
    const { host } = record(raw)
    if (host !== 'agent' && host !== 'terminal') {
      throw new ControlError('invalid_params', 'host must be agent or terminal')
    }
    return { host }
  },
  'devices.list': none,
  'devices.remove': (raw) => {
    const { id } = record(raw)
    if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID) {
      throw new ControlError('invalid_params', `id must be a string of 1 to ${MAX_ID} characters`)
    }
    return { id }
  },
}

export interface ControlServer {
  /** Stops listening and ends every connection. */
  close(): Promise<void>
}

/** Serves the CLI's requests on `socketPath` until it is closed. */
export async function serveControl(
  socketPath: string,
  handlers: ControlHandlers,
  warn: (message: string) => void,
): Promise<ControlServer> {
  const ports = new Set<PortChannel>()
  const server: Server = await listenPorts(socketPath, (port) => {
    ports.add(port)
    port.onClose(() => ports.delete(port))
    port.onMessage((data) => void answer(port, data))
  })
  return {
    close: () =>
      new Promise((resolve) => {
        // A client that keeps its end open cannot hold the daemon up.
        const timer = setTimeout(resolve, CLOSE_WAIT_MS)
        server.close(() => {
          clearTimeout(timer)
          resolve()
        })
        for (const port of ports) port.close()
      }),
  }

  async function answer(port: PortChannel, data: unknown): Promise<void> {
    const request = data as Request
    if (
      typeof request !== 'object' ||
      request === null ||
      request.type !== 'request' ||
      !Number.isSafeInteger(request.id)
    ) {
      warn('Ignored a malformed control message')
      return
    }
    const method = request.method as ControlMethod
    let reply: Reply
    try {
      if (typeof method !== 'string' || !Object.hasOwn(validators, method)) {
        throw new ControlError('unknown_method', `Unknown method "${String(method)}"`)
      }
      const params = validators[method](request.params)
      const handler = handlers[method] as (params: unknown) => Promise<unknown>
      reply = { type: 'response', id: request.id, result: (await handler(params)) ?? null }
    } catch (error) {
      const known = error instanceof ControlError
      if (!known) warn(`Control request ${String(method)} failed: ${(error as Error)?.stack}`)
      reply = {
        type: 'error',
        id: request.id,
        error: known
          ? { code: error.code, message: error.message }
          : { code: 'internal', message: 'The daemon could not answer' },
      }
    }
    port.send(reply)
  }
}

/** One request to the running daemon; throws `NotRunning` when nothing listens. */
export async function callControl<M extends ControlMethod>(
  socketPath: string,
  method: M,
  params: Params<M>,
  timeoutMs = 30_000,
): Promise<Result<M>> {
  let port: PortChannel
  try {
    port = await connectPort(socketPath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ECONNREFUSED') throw new NotRunning()
    throw error
  }
  return new Promise<Result<M>>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`The daemon did not answer within ${timeoutMs / 1000} s`))
      port.close()
    }, timeoutMs)
    port.onClose(() => {
      clearTimeout(timer)
      reject(new Error('The daemon closed the connection before it answered'))
    })
    port.onMessage((data) => {
      const reply = data as Reply
      if (reply?.id !== 1) return
      clearTimeout(timer)
      if (reply.type === 'response') resolve(reply.result as Result<M>)
      else reject(new ControlError(reply.error.code, reply.error.message))
      port.close()
    })
    port.send({ type: 'request', id: 1, method, params } satisfies Request)
  })
}
