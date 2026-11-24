// A relay the owner runs on a server of their own, in place of the Kettu relay. A host signs in to
// it with the relay's access key where the Kettu relay takes the account's token, and devices
// connect to it with no token at all: the host still decides inside the channel who may connect.
// The access key stays on the host. Imports nothing of Node.js, since browsers run it too.

import { isKettuServiceUrl } from '../kettu-hosts'
import {
  ACCESS_KEY_FEATURE,
  PING,
  RELAY_CLOSE,
  importRelayKey,
  newRelaySeed,
  relayHostId,
  SIGN_IN_TIMEOUT_MS,
  decodeRelayBytes,
  hostSocketPath,
  parseRelayInfo,
  parseRelayToHost,
  relayInfoPath,
  relayOrigin,
  relaySocketUrl,
  signInMessage,
  type RelayKey,
} from './relay'

/** A daemon in a container names its relay with the link the relay printed. */
export const RELAY_LINK_ENV = 'KETTU_RELAY_LINK'

/** Printable ASCII without spaces: the relay makes `krk_` and 43 base64url characters. */
const ACCESS_KEY = /^[\x21-\x7e]{16,512}$/

export const isAccessKey = (value: unknown): value is string =>
  typeof value === 'string' && ACCESS_KEY.test(value)

/** The base64url SHA-256 of a certificate's SubjectPublicKeyInfo, as an IP relay prints it. */
export const isRelayPin = (value: unknown): value is string =>
  typeof value === 'string' && decodeRelayBytes(value)?.length === 32

/** Whether an origin's host is this computer itself, where plain http may be used. */
export function isLoopbackOrigin(origin: string): boolean {
  const host = URL.parse(origin)?.hostname.replace(/^\[|\]$/g, '')
  if (!host) return false
  // URL gives an IPv4 address in its dotted form, so a name that only starts with 127. is none.
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  )
}

/** Why an address cannot be the owner's relay. */
export type OwnRelayAddressProblem =
  /** Not an http or https origin. */
  | 'address'
  /** Under Kettu's own domains: that is the Kettu relay, the other choice. */
  | 'kettu'
  /** Plain http to a relay not on this computer, which would send the key in the clear. */
  | 'http'

/** Why `url` cannot be the owner's relay, or null when it can. */
export function ownRelayProblem(url: string): OwnRelayAddressProblem | null {
  const origin = relayOrigin(url)
  if (!origin || origin !== url) return 'address'
  if (isKettuServiceUrl(origin)) return 'kettu'
  if (origin.startsWith('http:') && !isLoopbackOrigin(origin)) return 'http'
  return null
}

/** What the link a relay prints holds: `https://<relay>#key=<key>`, with `&pin=<pin>` at an IP. */
export interface RelayLink {
  url: string
  /** Null for an address pasted without the link's key. */
  key: string | null
  pin: string | null
}

/**
 * The relay's origin, key and pin from the link it printed or from an address alone; null when
 * the text is neither. The origin is not checked here beyond being one.
 */
export function parseRelayLink(text: string): RelayLink | null {
  const trimmed = text.trim()
  const at = trimmed.indexOf('#')
  const address = at < 0 ? trimmed : trimmed.slice(0, at)
  const parsed = URL.parse(address)
  if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) return null
  if (parsed.username || parsed.password || parsed.search) return null
  if (parsed.pathname !== '/' && parsed.pathname !== '') return null
  const url = parsed.origin
  if (at < 0) return { url, key: null, pin: null }
  const fields = new URLSearchParams(trimmed.slice(at + 1))
  const key = fields.get('key')
  const pin = fields.get('pin')
  if (key !== null && !isAccessKey(key)) return null
  if (pin !== null && !isRelayPin(pin)) return null
  return { url, key, pin }
}

/** The link that gives a relay with its key, as the relay prints it. */
export function relayLink(link: { url: string; key: string; pin: string | null }): string {
  const fields = new URLSearchParams({ key: link.key })
  if (link.pin) fields.set('pin', link.pin)
  return `${link.url}#${fields.toString()}`
}

/** What Use this relay asks for: the address, the key or null to keep the one kept, the pin. */
export interface OwnRelayInput {
  url: string
  key: string | null
  pin: string | null
}

/** Why a relay did not pass its check before a host switches to it. */
export type OwnRelayProblem =
  | OwnRelayAddressProblem
  /** No access key given, or not one. */
  | 'key'
  /** Nothing answered at the address. */
  | 'unreachable'
  /** Its certificate is not valid, or not the pinned one. */
  | 'certificate'
  /** It answered, but not as a Kettu relay. */
  | 'not_kettu'
  /** A Kettu relay of another protocol. */
  | 'protocol'
  /** A Kettu relay that takes no access key, as Kettu's own does not. */
  | 'no_access_key'
  /** It refused the key. */
  | 'key_refused'

export type OwnRelayCheck =
  | { ok: true; url: string; pin: string | null; version: string | null }
  | { ok: false; problem: OwnRelayProblem }

/** Failing to reach a relay, told apart from a certificate that is not the one it should be. */
export class RelayReachError extends Error {
  constructor(readonly problem: 'unreachable' | 'certificate') {
    super(problem === 'certificate' ? 'The relay showed another certificate' : 'No answer')
    this.name = 'RelayReachError'
  }
}

export interface OwnRelayCheckOptions {
  url: string
  key: string | null
  pin: string | null
  /** Reads JSON from the relay, through the pin; rejects with a RelayReachError when it cannot. */
  fetchInfo(url: string, pin?: string): Promise<unknown>
  openSocket(url: string, pin?: string): WebSocket
  timeoutMs?: number
}

/**
 * Checks a relay before a host uses it: an address it may use, a Kettu relay of protocol 1 that
 * takes access keys, reached with a valid certificate or the pinned one, and the key accepted by
 * a sign-in, which is closed again at once. The sign-in is a throwaway identity's, since one as
 * the host would replace the host's own connection to that relay.
 */
export async function checkOwnRelay(options: OwnRelayCheckOptions): Promise<OwnRelayCheck> {
  const { url, key } = options
  const pin = options.pin ?? undefined
  const address = ownRelayProblem(url)
  if (address) return { ok: false, problem: address }
  if (pin && !url.startsWith('https:')) return { ok: false, problem: 'address' }
  if (!isAccessKey(key)) return { ok: false, problem: 'key' }
  let raw: unknown
  try {
    raw = await options.fetchInfo(`${url}${relayInfoPath()}`, pin)
  } catch (error) {
    return {
      ok: false,
      problem: error instanceof RelayReachError ? error.problem : 'unreachable',
    }
  }
  const said = raw as { relay?: unknown; protocol?: unknown } | null
  if (said?.relay !== 'kettu') return { ok: false, problem: 'not_kettu' }
  const info = parseRelayInfo(raw)
  if (!info) return { ok: false, problem: 'protocol' }
  if (!info.features.includes(ACCESS_KEY_FEATURE)) return { ok: false, problem: 'no_access_key' }
  const signedIn = await trySignIn(options, key, pin)
  if (signedIn !== 'ok') return { ok: false, problem: signedIn }
  return { ok: true, url, pin: options.pin, version: info.version }
}

/** Signs in once with the key and closes: `ok`, or why not. */
async function trySignIn(
  options: OwnRelayCheckOptions,
  key: string,
  pin: string | undefined,
): Promise<'ok' | 'key_refused' | 'unreachable'> {
  const { url } = options
  const timeoutMs = options.timeoutMs ?? SIGN_IN_TIMEOUT_MS * 2
  const relayKey: RelayKey = await importRelayKey(await newRelaySeed())
  const id = await relayHostId(relayKey.publicKey)
  return new Promise((resolve) => {
    let socket: WebSocket
    try {
      socket = options.openSocket(relaySocketUrl(url, hostSocketPath(id)), pin)
    } catch {
      return resolve('unreachable')
    }
    let done = false
    const finish = (result: 'ok' | 'key_refused' | 'unreachable'): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        socket.close(1000)
      } catch {
        // Already closing.
      }
      resolve(result)
    }
    const timer = setTimeout(() => finish('unreachable'), timeoutMs)
    socket.addEventListener('message', (event) => {
      const data: unknown = event.data
      if (data === PING) return
      const message = parseRelayToHost(data)
      if (message?.type === 'challenge') {
        void signInMessage(relayKey, url, id, message.nonce, key).then(
          (signIn) => {
            if (!done) socket.send(JSON.stringify(signIn))
          },
          () => finish('unreachable'),
        )
      } else if (message?.type === 'ready') finish('ok')
    })
    socket.addEventListener('close', (event) => {
      const code = (event as CloseEvent).code
      finish(
        code === RELAY_CLOSE.unauthorized || code === RELAY_CLOSE.forbidden
          ? 'key_refused'
          : 'unreachable',
      )
    })
  })
}

/**
 * What a host's relay is told from its settings: the Kettu relay while it is chosen and Kettu's
 * services are on, or the owner's own relay, which needs its access key.
 */
export function relayChoiceInit(
  remote: { relay: 'kettu' | 'own' | 'off'; ownRelay: { url: string; pin: string | null } | null },
  cloud: boolean,
  key: string | null,
): { enabled: boolean; own: { url: string; pin: string | null; key: string } | null } {
  const own =
    remote.relay === 'own' && remote.ownRelay && key
      ? { url: remote.ownRelay.url, pin: remote.ownRelay.pin, key }
      : null
  return { enabled: remote.relay === 'kettu' && cloud, own }
}

/** The last four characters of an access key, which tell keys apart without showing one. */
export const accessKeyEnd = (key: string | null): string | null => (key ? key.slice(-4) : null)
