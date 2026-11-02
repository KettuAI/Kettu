// A window's one port to the sessions on the other hosts this computer connects to. Main relays
// it: every message names its host, so the one port carries each connected host's protocol.

import { HOST_METHODS, type HostEvent } from './agent-host'
import type { FromPort, ToPort } from './port-rpc'
import { isHostAdminMethod } from './remote/host-admin'
import type { TerminalsRestarted } from './remote/protocol'
import { TERMINAL_METHODS, type TerminalEvent } from './terminal-host'

const METHODS: ReadonlySet<string> = new Set([...HOST_METHODS, ...TERMINAL_METHODS])

/**
 * What a window may ask another host: its agent host's and terminal host's methods, and its
 * owner's calls to it, but not the answers to the host's browser calls, which main gives. The host
 * refuses the terminal's while its owner does not allow it. A new site's card is the user's to
 * answer, from any window.
 */
export function isOtherHostMethod(method: unknown): method is string {
  if (typeof method !== 'string') return false
  if (method.startsWith('browser.') && method !== 'browser.answerOrigin') return false
  return METHODS.has(method) || isHostAdminMethod(method)
}

/** What a window sends: a request for the host it names. */
export interface ToHosts {
  hostId: string
  message: ToPort
}

/**
 * What a host's session sends beyond the host protocol: a resync, after the host dropped patches,
 * and the terminals that ended when its terminal host did.
 */
export type HostSessionMessage =
  FromPort<HostEvent | TerminalEvent> | { type: 'resync' } | TerminalsRestarted

/** What main sends a window. */
export type FromHosts =
  /** A new session with the host opened: what the window lists of it is read again. */
  | { kind: 'open'; hostId: string }
  /** The session ended, and the requests in flight on it failed. */
  | { kind: 'closed'; hostId: string }
  | { kind: 'message'; hostId: string; message: HostSessionMessage }

/** What the page hears of a host's session. */
export type HostSessionChange =
  | { kind: 'open' }
  | { kind: 'closed' }
  /** The host dropped patches for this computer, which fell behind: what it shows is read again. */
  | { kind: 'resync' }
  | { kind: 'event'; event: HostEvent | TerminalEvent }
  /** The host's terminal host stopped or restarted, ending these terminals of this computer's. */
  | { kind: 'terminals-restarted'; ids: string[] }
