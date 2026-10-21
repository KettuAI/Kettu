// Errors that cross the port with a code the renderer can act on.

import type { PortError, PortErrorCode } from '@shared/port-rpc'

export class HostError extends Error {
  constructor(
    readonly code: PortErrorCode,
    message: string,
    readonly data?: unknown,
  ) {
    super(message)
    this.name = 'HostError'
  }

  toPortError(): PortError {
    return this.data === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, data: this.data }
  }
}

export function invalidParams(message: string): HostError {
  return new HostError('invalid_params', message)
}

export function notFound(message: string): HostError {
  return new HostError('not_found', message)
}

export function isHostError(error: unknown): error is HostError {
  return error instanceof HostError
}
