// ACP over the stdio of the agent's process: the driver of every agent that speaks ACP.

import type { ProcessDriver } from '../driver'
import { AcpConnection } from './connection'

export const ACP_DRIVER: ProcessDriver = {
  kind: 'process',
  connect: (transport, { def, hooks, spec, env }) =>
    AcpConnection.connect(transport, {
      ...hooks,
      agentId: def.id,
      name: def.name,
      ...(def.movedAccounts ? { movedAccounts: def.movedAccounts } : {}),
      ...(spec ? { spec } : {}),
      ...(env ? { env } : {}),
    }),
}
