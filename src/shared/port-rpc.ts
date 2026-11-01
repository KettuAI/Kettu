// The envelope used on every MessagePort between a renderer and a utility process (the agent
// host and the terminal host), and on a paired device's channel to the agent host.

export type PortErrorCode =
  | 'invalid_params'
  | 'unknown_method'
  | 'not_found'
  | 'busy'
  | 'restricted'
  | 'forbidden' // a device asked for what only a window may do, or the other way round
  | 'terminal_not_allowed' // a device asked for a terminal while the owner does not allow it
  | 'agent_unavailable'
  | 'auth_required'
  | 'agent_error'
  | 'git_error'
  | 'conflict'
  | 'host_restarted'
  | 'unavailable' // the host has no such service, as the daemon publishes nothing, or not now
  | 'internal'

export interface PortError {
  code: PortErrorCode
  message: string
  data?: unknown
}

export type ToPort = { type: 'request'; id: number; method: string; params: unknown }

export type FromPort<Event> =
  | { type: 'response'; id: number; result: unknown }
  | { type: 'error'; id: number; error: PortError }
  | { type: 'event'; event: Event }

export type PortConnectionState = 'connected' | 'reconnecting' | 'failed'

/** A port error as it reaches the renderer: an `Error` that keeps its code. */
export class PortRequestError extends Error {
  readonly code: PortErrorCode
  readonly data?: unknown
  constructor(error: PortError) {
    super(error.message)
    this.name = 'PortRequestError'
    this.code = error.code
    this.data = error.data
  }
}

export function isPortError(value: unknown): value is PortError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as PortError).code === 'string' &&
    typeof (value as PortError).message === 'string'
  )
}
