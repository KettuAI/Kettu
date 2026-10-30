// `codex app-server` over the stdio of the one process Kettu runs for Codex.

import type { Platform } from '@shared/platform'
import type { ProcessDriver } from '../driver'
import { CodexConnection } from './connection'

export const CODEX_DRIVER: ProcessDriver = {
  kind: 'process',
  reads: { limits: true },
  connect: (transport, { hooks, spec, env }) =>
    new CodexConnection(
      transport,
      hooks,
      spec && env ? { spec, env, platform: process.platform as Platform } : null,
    ),
}
