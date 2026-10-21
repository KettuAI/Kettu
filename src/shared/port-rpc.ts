// The envelope used on every MessagePort between a renderer and a utility process
// (the agent host and the terminal host).

export type PortErrorCode =
  | 'invalid_params'
  | 'unknown_method'
  | 'not_found'
  | 'busy'
  | 'restricted'
  | 'agent_unavailable'
  | 'auth_required'
  | 'agent_error'
  | 'git_error'
  | 'host_restarted'
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
