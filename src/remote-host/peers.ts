// WebRTC for peer-to-peer paths, from node-datachannel's standard RTCPeerConnection. Its addon is
// native and prebuilt per platform; where it does not load, peer to peer is off, logged once.

import type { RtcFactory, RtcPeerConnection } from '@shared/remote/p2p'
import type { LogFn } from '../agent-host/storage'

// The polyfill's own types lean on the DOM's WebRTC declarations, which this build has none of.
type Polyfill = { RTCPeerConnection: new (config: Parameters<RtcFactory>[0]) => RtcPeerConnection }

let loading: Promise<RtcFactory | null> | null = null

/** The peer connection factory once node-datachannel loads, or null where it cannot. */
export function loadPeers(log: LogFn): Promise<RtcFactory | null> {
  loading ??= import('node-datachannel/polyfill').then(
    (module): RtcFactory => {
      const { RTCPeerConnection } = module as unknown as Polyfill
      return (config) => new RTCPeerConnection(config)
    },
    (error: unknown) => {
      log('warn', `Peer-to-peer paths are off, as WebRTC did not load: ${(error as Error).message}`)
      return null
    },
  )
  return loading
}
