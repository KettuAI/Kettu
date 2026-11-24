// What a plugin's script may call on the agent host, and the one check every call goes through.

import { networkDomain } from '@shared/plugins'

/**
 * The permission a call needs: null for none, `network` for any `network:<domain>` permission
 * (the call checks the domain itself), or exactly the one named.
 */
export type CallPermission = string | null

export interface PluginCallContext {
  pluginId: string
  /** What the installed version of the plugin declares, which the user agreed to. */
  permissions: readonly string[]
}

export interface PluginApiCall {
  permission: CallPermission
  /** `args` come from the plugin's script: validate each one. */
  run(context: PluginCallContext, args: unknown[]): unknown
}

/** The permission a plugin lacks for a call, as the error names it; null when it has it. */
export function missingPermission(
  permission: CallPermission,
  granted: readonly string[],
): string | null {
  if (permission === null) return null
  if (permission === 'network') {
    return granted.some((item) => networkDomain(item) !== null) ? null : 'network:<domain>'
  }
  return granted.includes(permission) ? null : permission
}

/** The domains the plugin's network permissions name, as written. */
export function grantedDomains(granted: readonly string[]): string[] {
  return granted.flatMap((item) => {
    const domain = networkDomain(item)
    return domain === null ? [] : [domain]
  })
}
