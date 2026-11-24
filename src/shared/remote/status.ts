// Remote access as Settings and the tray show it, which main puts together from the setting, the
// remote host's reports and the computer's name.

import type { DirectStatus } from '../host-control'
import type { PairedDevice } from './device'
import type { RelayStatus } from './relay-host'

/** A device not seen for this long is removed. */
export const UNSEEN_DAYS = 90

/** In its last days before removal, a device's row says when. */
export const UNSEEN_NOTICE_DAYS = 7

const DAY = 24 * 60 * 60 * 1000

/** When a device not seen since will be removed. */
export function removalAt(device: Pick<PairedDevice, 'addedAt' | 'lastConnectedAt'>): number {
  return (device.lastConnectedAt ?? device.addedAt) + UNSEEN_DAYS * DAY
}

export interface RemoteStatus {
  /**
   * `off` while the setting is; `starting` until the remote host first reports; `on` while it runs;
   * `failed` when it cannot start, as when the system cannot decrypt its key.
   */
  state: 'off' | 'starting' | 'on' | 'failed'
  /** The name devices show for this computer: the owner's, or the system's. */
  hostName: string
  /** The system's name for the computer, which the host's name is until the owner changes it. */
  systemName: string
  devices: PairedDevice[]
  /** The ids of the devices with a session open now. */
  online: string[]
  /** The key is kept in a file only the user can read, without the system's encryption. */
  plainTextKey: boolean
  /**
   * A service that starts with the computer, which keeps its key in a file on every system since
   * it cannot count on an unlocked keyring; absent from the desktop app and older daemons.
   */
  service?: true
  /** Direct connections, as the remote host last reported them; `off` while it is not running. */
  direct: DirectStatus
  /** The Kettu relay; absent from older daemons. */
  relay?: RelayReport
  /**
   * The last four characters of the access key kept for the owner's own relay, whichever relay is
   * in use, so switching back can keep it; null for none, absent from older hosts.
   */
  ownRelayKeyEnd?: string | null
}

/**
 * The Kettu relay as Settings shows it: `off` while Use the Kettu relay is, `signed_out` while
 * this computer is signed in to no Kettu account, and otherwise each relay's state, none while
 * remote access is off.
 */
export type RelayReport =
  | { state: 'off' }
  | { state: 'signed_out' }
  /** With `own` on the owner's own relay, the one entry of `relays`; older clients see a relay. */
  | { state: 'on'; relays: RelayStatus[]; own?: OwnRelayReport }

/** The owner's own relay as Settings shows it, while it is the one chosen. */
export interface OwnRelayReport {
  url: string
  /** Its certificate is trusted by its pin alone, which browsers cannot check. */
  pinned: boolean
  /** The relay program's version, null until it says. */
  version: string | null
  /** The host's round trip to it in milliseconds, null before the first. */
  rtt: number | null
  /** It serves the web client, which a browser pairs on. */
  web: boolean
  /** The access key's last four characters, for telling keys apart; never the key. */
  keyEnd: string | null
}

/** The relay part of a host's report: the owner's own relay, the Kettu relay, or none. */
export function relayReport(options: {
  choice: 'kettu' | 'own' | 'off'
  /** The Kettu relay may be used here: Kettu's services are on. */
  cloud: boolean
  signedIn: boolean
  relays: RelayStatus[]
  own: { url: string; pin: string | null } | null
  ownStatus: { version: string | null; rtt: number | null; web: boolean } | null
  keyEnd: string | null
}): RelayReport {
  const { choice, own } = options
  if (choice === 'own' && own) {
    return {
      state: 'on',
      relays: options.relays,
      own: {
        url: own.url,
        pinned: own.pin !== null,
        version: options.ownStatus?.version ?? null,
        rtt: options.ownStatus?.rtt ?? null,
        web: options.ownStatus?.web ?? false,
        keyEnd: options.keyEnd,
      },
    }
  }
  if (choice !== 'kettu' || !options.cloud) return { state: 'off' }
  if (!options.signedIn) return { state: 'signed_out' }
  return { state: 'on', relays: options.relays }
}

/** The relay as one state: connected once any relay is, else how the others are doing. */
export type RelaySummary = 'off' | 'signed_out' | 'connected' | 'connecting' | 'conflict' | 'failed'

export function relaySummary(relay: RelayReport | undefined): RelaySummary | null {
  if (!relay) return null
  if (relay.state !== 'on') return relay.state
  const states = relay.relays.map(({ connection }) => connection.state)
  if (states.includes('connected')) return 'connected'
  if (states.includes('conflict')) return 'conflict'
  if (states.some((state) => state === 'retrying' || state === 'refused')) return 'failed'
  return 'connecting'
}
