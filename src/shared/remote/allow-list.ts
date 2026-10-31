// What a device may ask of the agent host: everything a window can, except what needs main. The
// remote host and the agent host both check it, so a remote host that misbehaves cannot widen it.

import type { HostMethod } from '../agent-host'

// A file main's media scheme serves, and a folder only main's dialog picks until devices get a
// folder browser of their own.
const MAIN_ONLY: ReadonlySet<string> = new Set<HostMethod>(['media.open', 'projects.add'])

function hasGrant(params: unknown): boolean {
  if (typeof params !== 'object' || params === null) return false
  const source = (params as { source?: unknown }).source
  return typeof source === 'object' && source !== null && 'grantId' in source
}

/**
 * Whether a device is refused this request: a host method that needs main, or an attachment from
 * a file main granted to a window. A method the host does not know is not this list's to refuse.
 */
export function forbiddenToDevices(method: string, params: unknown): boolean {
  if (MAIN_ONLY.has(method)) return true
  return method === 'attachments.add' && hasGrant(params)
}
