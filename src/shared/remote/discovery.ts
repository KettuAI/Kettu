// Pairing with a host of the same Kettu account without a code: the relay lists the account's
// hosts, the device runs Noise IK with the discovery prologue to the listed key, and both sides
// show a six-digit code built from a commit-then-reveal exchange. The device's user confirms the
// code matches, which catches a relay that listed a key of its own; the host's owner adds the
// device, which shows they control the host and want it. Imports nothing of Node.js.

import type { Platform } from '../platform'
import type { PairingDevice } from './pairing'

/** Binds a discovery handshake apart from a paired device's and a code's. */
export const DISCOVER_PROLOGUE = new TextEncoder().encode('kettu-channel/1 discover')

/** How long the host's owner and the device's user have to answer. */
export const DISCOVERY_ASK_MS = 2 * 60_000

/** Requests rejected or voided in a row before the host takes none for a while. */
export const DISCOVERY_STRIKES = 3

/** How long a host takes no discovery request after DISCOVERY_STRIKES. */
export const DISCOVERY_COOLDOWN_MS = 10 * 60_000

/** The bytes of each side's random nonce. */
export const DISCOVERY_NONCE_BYTES = 32

/** The device's first message on the channel: the SHA-256 of its nonce, in base64url. */
export interface PairCommit {
  type: 'pair-commit'
  commit: string
}

/** The host's answer to the commit: its nonce, in base64url. */
export interface PairNonce {
  type: 'pair-nonce'
  nonce: string
}

/** The device's nonce, in base64url, after which both sides know the code. */
export interface PairReveal {
  type: 'pair-reveal'
  nonce: string
}

/** The device's user saw the same code on both screens. */
export interface PairConfirm {
  type: 'pair-confirm'
}

export type DiscoveryMessage = PairCommit | PairNonce | PairReveal | PairConfirm

/** A host of the account, as this computer may pair with it; paired ones and itself left out. */
export interface DiscoveredHost {
  /** The host's id on the relay. */
  relayId: string
  /** Its X25519 public key, in base64, as a known host keeps it. */
  publicKey: string
  name: string
  platform: Platform
}

/** What listing the account's hosts gives. */
export type DiscoveredHosts =
  | { state: 'ok'; hosts: DiscoveredHost[] }
  /** No Kettu sign-in, so no relay to ask. */
  | { state: 'signed_out' }
  /** No relay answered. */
  | { state: 'unavailable' }

/** Why a discovery request ended on the host. */
export type DiscoveryEnd =
  | 'added'
  | 'rejected'
  /** The device's user cancelled, said the codes differ, or its connection ended. */
  | 'cancelled'
  | 'expired'
  /** Remote access stopped, or discovery was turned off. */
  | 'stopped'

/** A discovery request as the host's owner sees it. */
export type DiscoveryRequestState =
  | {
      state: 'confirm'
      device: PairingDevice
      code: string
      startedAt: number
      expiresAt: number
    }
  | { state: 'closed'; reason: DiscoveryEnd }

/** A discovery request's progress, to every window of the host. */
export interface DiscoveryRequestEvent {
  requestId: number
  request: DiscoveryRequestState
}
