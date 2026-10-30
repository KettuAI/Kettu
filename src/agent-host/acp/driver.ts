// ACP over the stdio of the agent's process: the driver of every agent that speaks ACP.

import type { ProcessDriver } from '../driver'
import { AcpConnection } from './connection'

export const ACP_DRIVER: ProcessDriver = {
  kind: 'process',
  connect: (transport, { def, hooks }) =>
    AcpConnection.connect(transport, {
      ...hooks,
      agentId: def.id,
      name: def.name,
      levelsAsModes: def.levelsAsModes ?? false,
      startupNote: def.startupNote ?? false,
    }),
}
