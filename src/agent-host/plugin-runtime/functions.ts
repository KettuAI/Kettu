// The host functions a plugin's script may call that the agent host answers. This object is the
// whole list; it is empty until the plugin API's calls are added, each behind its permission.

import type { PluginFunction } from './client'

export const PLUGIN_FUNCTIONS: Readonly<Record<string, PluginFunction>> = Object.freeze({})
