// ACP over the stdio of the agent's process: the driver of every agent that speaks ACP.

import type { AgentTransport, DriverContext, HostedDriver, ProcessDriver } from '../driver'
import { FolderConnections } from '../folder-connections'
import { AcpConnection } from './connection'

function connect(transport: AgentTransport, context: DriverContext): AcpConnection {
  const { def, hooks, spec, env, home } = context
  return AcpConnection.connect(transport, {
    ...hooks,
    agentId: def.id,
    name: def.name,
    ...(def.movedAccounts ? { movedAccounts: def.movedAccounts } : {}),
    ...(spec ? { spec } : {}),
    ...(env ? { env } : {}),
    ...(home ? { home } : {}),
  })
}

export const ACP_DRIVER: ProcessDriver = { kind: 'process', connect }

/**
 * ACP for a harness whose process applies a folder's own config to every session and turns it off
 * only for all of them with `folderConfigOff`: the host runs one process with it on for every
 * session, and a second without it for the folders whose own settings the user let apply.
 */
export const ACP_FOLDERS_DRIVER: HostedDriver = {
  kind: 'hosted',
  connect: (context) => {
    const off = context.def.folderConfigOff ?? {}
    return new FolderConnections({
      make: (held) => {
        const env = held ? { ...context.env, ...off } : context.env
        const child = context.spawn({
          command: context.spec.command,
          args: context.spec.args,
          env: { ...env, ...context.spec.env },
        })
        return connect(
          { kind: 'stdio', stdin: child.stdin!, stdout: child.stdout! },
          {
            ...context,
            env,
          },
        )
      },
    })
  },
}
