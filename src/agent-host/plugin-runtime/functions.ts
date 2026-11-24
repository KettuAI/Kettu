// The plugin API: the host functions a plugin's script may call, and nothing else. Each names the
// permission it needs, and the client answers it only to a plugin that has it. Within one major
// version a call is only ever added, never changed or removed.

import type { Locale } from '@shared/locale'
import { PLUGIN_API_VERSIONS } from '@shared/plugins'
import type { PluginApiCall } from './call'
import { httpsTransport, networkFetch, type HttpTransport } from './network'
import { sessionCalls, type PluginSessionsDeps } from './sessions-api'

/** The events delivered to the plugins that are loaded, each as its call's value changes. */
export const PLUGIN_EVENTS = ['app.locale', 'app.colorMode'] as const

export type ColorMode = 'light' | 'dark'

export interface PluginApiDeps {
  locale(): Locale
  /** The window's color mode; null where there is no window, as under the daemon. */
  colorMode(): ColorMode | null
  sessions: PluginSessionsDeps
  transport?: HttpTransport
}

export function createPluginApi(deps: PluginApiDeps): Readonly<Record<string, PluginApiCall>> {
  return Object.freeze({
    'api.version': { permission: null, run: () => PLUGIN_API_VERSIONS.at(-1) },
    'app.locale': { permission: null, run: () => deps.locale() },
    'app.colorMode': { permission: null, run: () => deps.colorMode() },
    'network.fetch': networkFetch(deps.transport ?? httpsTransport),
    ...sessionCalls(deps.sessions),
  })
}
