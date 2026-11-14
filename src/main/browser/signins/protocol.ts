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
