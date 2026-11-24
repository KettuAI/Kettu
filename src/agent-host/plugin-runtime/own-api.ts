// What a plugin's script may do with what is its own: its settings, its secrets and its storage.
// No permission is needed for any of it, since it reaches nothing but the plugin's own data.

import { PLUGIN_STORAGE_LIMITS, type PluginSettingValue } from '@shared/plugins'
import type { PluginApiCall } from './call'
import type { PluginStorage } from './storage'

export interface PluginOwnDeps {
  /** What a setting of the plugin holds now; throws for a key the plugin does not declare. */
  setting(pluginId: string, key: string): PluginSettingValue
  /** The value of a secret the plugin declares, or null while it is not set. */
  secret(pluginId: string, key: string): string | null
  storage: Pick<PluginStorage, 'get' | 'set' | 'delete' | 'keys'>
}

function key(args: unknown[], what: string): string {
  const [value] = args
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > PLUGIN_STORAGE_LIMITS.keyChars
  ) {
    throw new Error(`${what} must be a key of 1 to ${PLUGIN_STORAGE_LIMITS.keyChars} characters`)
  }
  return value
}

export function ownCalls(deps: PluginOwnDeps): Record<string, PluginApiCall> {
  return {
    'settings.get': {
      permission: null,
      run: ({ pluginId }, args) => deps.setting(pluginId, key(args, 'The setting')),
    },
    'settings.secret': {
      permission: null,
      run: ({ pluginId }, args) => deps.secret(pluginId, key(args, 'The secret')),
    },
    'storage.get': {
      permission: null,
      run: ({ pluginId }, args) => deps.storage.get(pluginId, key(args, 'The storage key')),
    },
    'storage.set': {
      permission: null,
      run: ({ pluginId }, args) =>
        deps.storage.set(pluginId, key(args, 'The storage key'), args[1] ?? null),
    },
    'storage.delete': {
      permission: null,
      run: ({ pluginId }, args) => deps.storage.delete(pluginId, key(args, 'The storage key')),
    },
    'storage.keys': {
      permission: null,
      run: ({ pluginId }) => deps.storage.keys(pluginId),
    },
  }
}
