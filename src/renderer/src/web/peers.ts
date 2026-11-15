// The browser's own WebRTC for peer-to-peer paths to the host, where the page has it.

import type { PeerSystem } from '@shared/remote/p2p'

/** Peer-to-peer paths with `stun`'s servers; none in a browser without RTCPeerConnection. */
export function browserPeers(stun: () => readonly string[]): () => PeerSystem | null {
  return () =>
    typeof RTCPeerConnection === 'function'
      ? { create: (config) => new RTCPeerConnection(config), stun }
      : null
}
