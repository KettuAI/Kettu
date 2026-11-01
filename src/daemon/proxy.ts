// The proxy of the daemon's own requests, as the app's sessions follow Settings › Advanced: the
// custom proxy, else the proxy variables the daemon runs with.

import { setGlobalProxyFromEnv } from 'node:http'
import type { ProxySettings } from '@shared/settings'
import { applyProxy } from '../agent-host/shell-env'

const PROXY_VARIABLES = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'].flatMap((name) => [
  name,
  name.toLowerCase(),
])

/** The proxy variables the process's fetch was last given, as JSON. */
let applied: string | null = null
/** Puts the process's fetch back as it started, before the last proxy was set. */
let restore: (() => void) | null = null

/**
 * A fetch through the proxy `proxy()` sets. Node's fetch takes its proxy from the whole process,
 * so each request first sets it there when the setting changed since the last one.
 */
export function proxiedFetch(
  proxy: () => ProxySettings,
  env: NodeJS.ProcessEnv,
): (url: string, init: RequestInit) => Promise<Response> {
  return (url, init) => {
    const variables = applyProxy(env, proxy(), process.platform)
    const chosen = JSON.stringify(PROXY_VARIABLES.map((name) => variables[name] ?? null))
    if (chosen !== applied) {
      // Setting variables that name no proxy changes nothing, so a change starts from no proxy.
      restore?.()
      restore = setGlobalProxyFromEnv(variables)
      applied = chosen
    }
    return fetch(url, init)
  }
}
