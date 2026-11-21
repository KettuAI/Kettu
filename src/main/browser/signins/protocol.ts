// Messages between main and the sign-ins worker.

import type { SignInChoice, SignInRequest } from '@shared/signins'

export type WorkerRequest =
  | { op: 'sources' }
  | { op: 'sites'; choice: SignInChoice }
  | { op: 'index' }
  | { op: 'read'; request: SignInRequest }
  /** Stops a read waiting for the keychain. */
  | { op: 'cancel' }

export type WorkerReply = { ok: true; value: unknown } | { ok: false; error: string }

/** A failure of the worker itself, worded for the user, with the same in English for the log. */
export class WorkerError extends Error {
  constructor(
    message: string,
    readonly log: string,
  ) {
    super(message)
    this.name = 'WorkerError'
  }
}

/** A failed read as a log line says it. */
export function readLog(error: unknown): string {
  return error instanceof WorkerError ? error.log : (error as Error).message
}
