// Cline's driver: its SDK in a process of Kettu's own, chosen when the Agent starts. Where that
// process cannot start, as with an install that has no SDK or a runtime it does not load in, the
// Agent runs `cline --acp` as before; nothing switches while the Agent runs.

import { AcpConnection } from '../acp/connection'
import type { AgentConnection } from '../connection'
import type { HostedContext, HostedDriver } from '../driver'
import { ClineConnection, ClineSdkUnavailable } from './connection'

/** Cline over ACP, on the process the launch names, started as a run in the host starts one. */
function acpConnection(context: HostedContext): AgentConnection {
  const { def, hooks, spec, env } = context
  const child = context.spawn({
    command: spec.command,
    args: spec.args,
    env: { ...env, ...spec.env },
  })
  const connection = AcpConnection.connect(
    { kind: 'stdio', stdin: child.stdin!, stdout: child.stdout! },
    { ...hooks, agentId: def.id, name: def.name },
  )
  const end = (): void => connection.close()
  child.once('exit', end)
  child.once('error', end)
  return connection
}

/**
 * A connection that is `first` unless its `initialize` says it cannot serve the Agent, and then
 * the one `fallback` makes. Until `initialize` settles only `closed` and `close` are its own.
 */
export function withFallback(
  first: AgentConnection,
  unavailable: (error: unknown) => boolean,
  fallback: () => AgentConnection,
  chose: (reason: string) => void,
): AgentConnection {
  let inner = first
  // While `first` tries to start, its closing is the start's failure and not the Agent's end.
  let starting = false
  let closedStarting = false
  let resolveClosed!: () => void
  const closed = new Promise<void>((resolve) => (resolveClosed = resolve))
  const follow = (connection: AgentConnection): void => {
    const ended = (): void => {
      if (inner !== connection) return
      if (starting) closedStarting = true
      else resolveClosed()
    }
    void connection.closed.then(ended, ended)
  }
  follow(first)
  const initialize: AgentConnection['initialize'] = async (appVersion, signal) => {
    starting = true
    try {
      return await first.initialize(appVersion, signal)
    } catch (error) {
      if (!unavailable(error)) throw error
      chose((error as Error).message)
      inner = fallback()
      closedStarting = false
      follow(inner)
      first.close()
      return await inner.initialize(appVersion, signal)
    } finally {
      starting = false
      if (closedStarting) resolveClosed()
    }
  }
  return new Proxy({} as AgentConnection, {
    get(_target, property) {
      if (property === 'closed') return closed
      if (property === 'initialize') return initialize
      const value = Reflect.get(inner, property, inner) as unknown
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(inner)
        : value
    },
    has: (_target, property) => property in inner,
  })
}

export const CLINE_SDK_DRIVER: HostedDriver = {
  kind: 'hosted',
  connect: (context) =>
    withFallback(
      new ClineConnection(context),
      (error) => error instanceof ClineSdkUnavailable,
      () => acpConnection(context),
      (reason) =>
        context.hooks.log('warn', `Cline's SDK did not start, so it runs over ACP: ${reason}`),
    ),
}
