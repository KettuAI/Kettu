// The plugin API: the host functions a plugin's script may call, and nothing else. Each names the
// permission it needs, and the client answers it only to a plugin that has it. Within one major
// version a call is only ever added, never changed or removed.

import { randomBytes } from 'node:crypto'
import type { Locale } from '@shared/locale'
import { PLUGIN_API_VERSIONS } from '@shared/plugins'
import type { PluginApiCall } from './call'
import { relayCall, type PluginChannels } from './channels'
import { httpsTransport, networkFetch, type HttpTransport } from './network'
import { ownCalls, type PluginOwnDeps } from './own-api'
import { sessionCalls, type PluginSessionsDeps } from './sessions-api'

/** The events delivered to the plugins that are loaded, each as its call's value changes. */
export const PLUGIN_EVENTS = ['app.locale', 'app.colorMode', 'settings.changed'] as const

export type ColorMode = 'light' | 'dark'

/** The most bytes one `random.bytes` call gives. */
export const RANDOM_BYTES_MAX = 256

/** Cryptographic random bytes as lowercase hex, since the script has only `Math.random`. */
function randomHex([length]: unknown[]): string {
  if (
    !Number.isInteger(length) ||
    (length as number) < 1 ||
    (length as number) > RANDOM_BYTES_MAX
  ) {
    throw new Error(`The length must be a whole number of 1 to ${RANDOM_BYTES_MAX}`)
  }
  return randomBytes(length as number).toString('hex')
}

export interface PluginApiDeps {
  locale(): Locale
  /** The window's color mode; null where there is no window, as under the daemon. */
  colorMode(): ColorMode | null
  sessions: PluginSessionsDeps
  own: PluginOwnDeps
  /** Where a relayed answer goes. */
  channels: Pick<PluginChannels, 'answer'>
  transport?: HttpTransport
}

export function createPluginApi(deps: PluginApiDeps): Readonly<Record<string, PluginApiCall>> {
  return Object.freeze({
    'api.version': { permission: null, run: () => PLUGIN_API_VERSIONS.at(-1) },
    'app.locale': { permission: null, run: () => deps.locale() },
    'app.colorMode': { permission: null, run: () => deps.colorMode() },
    'random.bytes': { permission: null, run: (_, args) => randomHex(args) },
    'network.fetch': networkFetch(deps.transport ?? httpsTransport),
    ...ownCalls(deps.own),
    'requests.answer': relayCall(deps.channels),
    ...sessionCalls(deps.sessions),
  })
}
