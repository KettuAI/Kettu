// Global registry for the virtual artifact frame host, kept outside React components to satisfy react-refresh.

import type { VirtualFrameHost } from '@renderer/web/virtual-frames'

let virtualHost: VirtualFrameHost | null = null

/** Registers the virtual frame host for hosted and relay web clients; desktop and direct web stay null. */
export function setVirtualFrameHost(next: VirtualFrameHost | null): void {
  virtualHost = next
}

/** Returns the active virtual frame host, or null on desktop and host-served web clients. */
export function getVirtualFrameHost(): VirtualFrameHost | null {
  return virtualHost
}
