import type { ProxyConfig } from 'electron'
import type { ProxySettings } from '@shared/settings'

/** The proxy setting for a session of main's own: the system's, or the one given. */
export function sessionProxy(proxy: ProxySettings): ProxyConfig {
  if (proxy.mode !== 'custom') return { mode: 'system' }
  // Chromium wants scheme://host:port, without a path or credentials.
  const url = new URL(proxy.url)
  return { proxyRules: `${url.protocol}//${url.host}`, proxyBypassRules: proxy.noProxy }
}
