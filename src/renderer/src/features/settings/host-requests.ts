// What the other hosts this desktop app connects to say of devices joining them: a device of the
// account that asks to be added, which this computer may answer, and a device that joined.

import { parseDiscoveryEvent, type DiscoveryRequestEvent } from '@shared/remote/discovery'
import { parseJoined, type JoinedDevice, type JoinedVia } from '@shared/remote/host-admin'

export interface HostRequestHandlers {
  discovery(hostId: string, event: DiscoveryRequestEvent): void
  joined(hostId: string, joined: { device: JoinedDevice; via: JoinedVia }): void
  /** The host's session opened, so what waits there is read again. */
  opened(hostId: string): void
  closed(hostId: string): void
}

const handlers = new Set<HostRequestHandlers>()
const open = new Set<string>()

/** One of another host's events; true when it was one of these. */
export function hostRequestEvent(hostId: string, event: { type: string }): boolean {
  if (event.type === 'remote.discovery') {
    const parsed = parseDiscoveryEvent((event as { event?: unknown }).event)
    if (parsed) for (const handler of handlers) handler.discovery(hostId, parsed)
    return true
  }
  if (event.type === 'remote.deviceJoined') {
    const joined = parseJoined(event as { device?: unknown; via?: unknown })
    if (joined) for (const handler of handlers) handler.joined(hostId, joined)
    return true
  }
  return false
}

export function hostRequestsOpened(hostId: string): void {
  open.add(hostId)
  for (const handler of handlers) handler.opened(hostId)
}

export function hostRequestsClosed(hostId: string): void {
  open.delete(hostId)
  for (const handler of handlers) handler.closed(hostId)
}

/** Hears the other hosts' requests, starting with those whose sessions are open already. */
export function onHostRequests(handler: HostRequestHandlers): () => void {
  handlers.add(handler)
  for (const hostId of open) handler.opened(hostId)
  return () => {
    handlers.delete(handler)
  }
}
