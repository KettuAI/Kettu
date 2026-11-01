// The control socket: how the CLI reaches the running daemon, which alone writes the host's state.
// It sits in the data folder, which only the user can open, and carries the envelope of the hosts'
// ports, framed as their sockets frame it.

import type { Server } from 'node:net'
import type { DirectStatus } from '@shared/host-control'
import type { PortChannel } from '@shared/port-channel'
import { isPort, MIN_OWN_PORT, parseDirectAddress } from '@shared/remote/address'
import {
  DEVICE_ID,
  isDeviceField,
  isDeviceModel,
  normalizeDeviceName,
  type NewDevice,
} from '@shared/remote/device'
import type { Platform } from '@shared/platform'
import type { PairingState } from '@shared/remote/pairing'
import type { DirectAddress } from '@shared/remote/protocol'
import { connectPort, listenPorts } from '@shared/socket-port'
import { publicKeyBytes } from '../remote-host/devices'
import type { HostState } from './forked-host'

/** A host that takes ports; the remote host takes devices' connections instead. */
export type HostName = 'agent' | 'terminal'

export interface HostStatus {
  state: HostState
  pid: number | null
  /** How many times the daemon restarted it after it exited. */
  restarts: number
}

/** A paired device, without its key. */
export interface DeviceSummary {
  id: string
  name: string
  kind: string
  platform: string
  /** It has a session open now. */
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
  hosts: Record<HostName | 'remote', HostStatus>
  /** How many devices are connected, or null while remote access is not running. */
  connectedDevices: number | null
  /** Direct connections as the remote host runs them, or null while remote access is not running. */
  direct: DirectStatus | null
}

/** Direct connections: what the settings ask for and what the remote host makes of them. */
export interface DirectReport {
  /** The port the settings name, picked at random on the first run. */
  port: number | null
  /** The owner's own addresses, which devices try first. */
  own: DirectAddress[]
  /** As the remote host runs them, or null while remote access is not running. */
  status: DirectStatus | null
}

/** What the app says when an address of the owner's own is not one. */
export const ADDRESS_PROBLEM =
  'Not an address: enter only a host name or IP address and a port, such as ' +
  'frp.example.com:60021, without https://'

/** What the app says when a port is not one the owner may pick. */
export const PORT_PROBLEM = `Use a port from ${MIN_OWN_PORT} to 65535`

export interface ControlCalls {
  status: { params: undefined; result: DaemonStatus }
  /** A host's socket, for a port of its own; the terminal host starts on the first ask. */
  'host.socket': { params: { host: HostName }; result: { path: string } }
  'devices.list': { params: undefined; result: DeviceSummary[] }
  'devices.remove': { params: { id: string }; result: null }
  /**
   * Opens a pairing code for this connection, voiding any other. Its progress comes as `pairing`
   * events on the connection, and the code is void once the connection closes.
   */
  'pair.open': { params: undefined; result: { codeId: number } }
  /** Adds the device this connection's code was asked about, under `name`, or rejects it. */
  'pair.answer': { params: { codeId: number; add: boolean; name: string }; result: null }
  'direct.get': { params: undefined; result: DirectReport }
  /**
   * Listens on another port, or tries the same one again after it could not be opened; settles
   * with what came of it.
   */
  'direct.port': { params: { port: number }; result: DirectReport }
  /** Adds an address of the owner's own, which devices online get at once. */
  'direct.add': { params: DirectAddress; result: DirectReport }
  'direct.remove': { params: DirectAddress; result: DirectReport }
  /** Whether devices may use this computer's terminal. */
  'terminal.get': { params: undefined; result: TerminalReport }
  /** Allows devices the terminal, or stops allowing it, which closes their terminals at once. */
  'terminal.set': { params: { allowed: boolean }; result: TerminalReport }
  /**
   * What a computer adding this one over SSH connects with, after adding its `device`, whose key
   * came over the login, as a device of the owner's.
   */
  'ssh.setup': { params: { device: NewDevice | null }; result: SshSetup }
}

export interface TerminalReport {
  allowed: boolean
}

/** What a computer adding this one over SSH connects with. */
export interface SshSetup {
  /** The host's X25519 public key, in base64, which the channel's handshake is made to. */
  publicKey: string
  name: string
  platform: Platform
  version: string
  /** The port it takes channels from SSH on, on 127.0.0.1 alone. */
  port: number
}

/** What the daemon tells a connection unasked. */
export type ControlEvent = { type: 'pairing'; codeId: number; pairing: PairingState }

/** One client's connection, as a handler sees it. */
export interface ControlConnection {
  notify(event: ControlEvent): void
  /** Runs once the client is gone. */
  onClose(listener: () => void): void
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
  | { type: 'event'; event: ControlEvent }

export type ControlHandlers = {
  [M in ControlMethod]: (params: Params<M>, connection: ControlConnection) => Promise<Result<M>>
}

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

function address(raw: unknown): DirectAddress {
  const parsed = parseDirectAddress(record(raw))
  if (!parsed) throw new ControlError('invalid_params', ADDRESS_PROBLEM)
  return parsed
}

function newDevice(raw: unknown): NewDevice {
  const { publicKey, name, kind, platform, model } = record(raw)
  if (typeof publicKey !== 'string' || !publicKeyBytes(publicKey)) {
    throw new ControlError('invalid_params', "A device's key is 32 bytes in base64")
  }
  const kept = normalizeDeviceName(name)
  if (kept === null) throw new ControlError('invalid_params', 'The name must not be empty')
  if (!isDeviceField(kind) || !isDeviceField(platform) || !isDeviceModel(model)) {
    throw new ControlError('invalid_params', "The device's kind, platform or model is not one")
  }
  return { publicKey, name: kept, kind, platform, model }
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
    if (typeof id !== 'string' || !DEVICE_ID.test(id)) {
      throw new ControlError('invalid_params', "A device's id is 32 hexadecimal digits")
    }
    return { id }
  },
  'pair.open': none,
  'pair.answer': (raw) => {
    const { codeId, add, name } = record(raw)
    if (!Number.isSafeInteger(codeId)) {
      throw new ControlError('invalid_params', 'codeId must be an integer')
    }
    if (typeof add !== 'boolean') throw new ControlError('invalid_params', 'add must be a boolean')
    const kept = add ? normalizeDeviceName(name) : ''
    if (kept === null) throw new ControlError('invalid_params', 'The name must not be empty')
    return { codeId: codeId as number, add, name: kept }
  },
  'direct.get': none,
  'direct.port': (raw) => {
    const { port } = record(raw)
    if (!isPort(port) || port < MIN_OWN_PORT) throw new ControlError('invalid_params', PORT_PROBLEM)
    return { port }
  },
  'direct.add': address,
  'direct.remove': address,
  'terminal.get': none,
  'terminal.set': (raw) => {
    const { allowed } = record(raw)
    if (typeof allowed !== 'boolean') {
      throw new ControlError('invalid_params', 'allowed must be a boolean')
    }
    return { allowed }
  },
  'ssh.setup': (raw) => {
    const { device } = record(raw)
    return { device: device === undefined || device === null ? null : newDevice(device) }
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
    const connection: ControlConnection = {
      notify: (event) => port.send({ type: 'event', event } satisfies Reply),
      onClose: (listener) => port.onClose(listener),
    }
    port.onMessage((data) => void answer(port, connection, data))
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

  async function answer(
    port: PortChannel,
    connection: ControlConnection,
    data: unknown,
  ): Promise<void> {
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
      const handler = handlers[method] as (
        params: unknown,
        connection: ControlConnection,
      ) => Promise<unknown>
      const result = await handler(params, connection)
      reply = { type: 'response', id: request.id, result: result ?? null }
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

/** A connection to the running daemon, for several requests and the events between them. */
export interface ControlClient {
  call<M extends ControlMethod>(
    method: M,
    params: Params<M>,
    timeoutMs?: number,
  ): Promise<Result<M>>
  onEvent(listener: (event: ControlEvent) => void): void
  /** Runs once the connection is gone, closed by either end. */
  onClose(listener: () => void): void
  close(): void
}

/** Connects to the running daemon; throws `NotRunning` when nothing listens. */
export async function connectControl(socketPath: string): Promise<ControlClient> {
  let port: PortChannel
  try {
    port = await connectPort(socketPath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ECONNREFUSED') throw new NotRunning()
    throw error
  }
  const pending = new Map<number, (reply: Reply | null) => void>()
  const eventListeners: ((event: ControlEvent) => void)[] = []
  let nextId = 1
  let closed = false
  port.onClose(() => {
    closed = true
    for (const settle of [...pending.values()]) settle(null)
  })
  port.onMessage((data) => {
    const reply = data as Reply
    if (reply?.type === 'event') {
      for (const listener of eventListeners) listener(reply.event)
    } else if (reply && pending.has(reply.id)) {
      pending.get(reply.id)!(reply)
    }
  })
  return {
    call: (method, params, timeoutMs = 30_000) =>
      new Promise((resolve, reject) => {
        const id = nextId++
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`The daemon did not answer within ${timeoutMs / 1000} s`))
        }, timeoutMs)
        pending.set(id, (reply) => {
          clearTimeout(timer)
          pending.delete(id)
          if (!reply) reject(new Error('The daemon closed the connection before it answered'))
          else if (reply.type === 'response') resolve(reply.result as Result<typeof method>)
          else if (reply.type === 'error') {
            reject(new ControlError(reply.error.code, reply.error.message))
          }
        })
        if (closed) pending.get(id)!(null)
        else port.send({ type: 'request', id, method, params } satisfies Request)
      }),
    onEvent: (listener) => void eventListeners.push(listener),
    onClose: (listener) => port.onClose(listener),
    close: () => port.close(),
  }
}

/** One request to the running daemon; throws `NotRunning` when nothing listens. */
export async function callControl<M extends ControlMethod>(
  socketPath: string,
  method: M,
  params: Params<M>,
  timeoutMs = 30_000,
): Promise<Result<M>> {
  const client = await connectControl(socketPath)
  try {
    return await client.call(method, params, timeoutMs)
  } finally {
    client.close()
  }
}
