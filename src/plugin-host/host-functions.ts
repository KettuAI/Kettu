// The host functions a plugin's script may call by name, answered in the plugin host itself. This
// object is the whole list: a name that is not an own key here goes to the agent host, which
// answers from a list of its own.

import type { LogLevel } from '@shared/log/process-log'

export interface HostFunctionContext {
  pluginId: string
  log(level: LogLevel, text: string): void
}

export type HostFunction = (context: HostFunctionContext, args: unknown[]) => unknown

export type HostFunctions = Readonly<Record<string, HostFunction>>

export const HOST_FUNCTIONS: HostFunctions = Object.freeze({
  log: ({ log }, [text]) => {
    log('info', typeof text === 'string' ? text : (JSON.stringify(text) ?? 'undefined'))
    return null
  },
  echo: (_, [value]) => value ?? null,
})
