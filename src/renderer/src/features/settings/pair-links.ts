// The links a browser opens a pairing code with, one for each of the host's addresses.

import { addressKey, addressText } from '@shared/remote/address'
import {
  browserPairingLink,
  HOSTED_WEB_URL,
  hostedPairingLink,
  parsePairingLink,
} from '@shared/remote/pairing'
import type { DirectAddress } from '@shared/remote/protocol'

/**
 * The browser's links: the hosted web client's first for a code with the relay, which works on any
 * network with the account, unless Kettu's cloud is off here; then each of the code's addresses
 * that a browser can open, the ones this computer found first: a browser on the same network is
 * the usual one, and the owner's own addresses, such as a forwarded port, often reach it from
 * outside in plain http.
 */
export function browserLinks(
  appLink: string | null,
  own: DirectAddress[],
  cloud: boolean,
): { address: string; link: string }[] {
  const payload = appLink ? parsePairingLink(appLink) : null
  if (!payload) return []
  const owned = new Set(own.map(addressKey))
  const found = payload.addresses.filter((address) => !owned.has(addressKey(address)))
  const theirs = payload.addresses.filter((address) => owned.has(addressKey(address)))
  const hosted = cloud ? hostedPairingLink(payload) : null
  return [
    ...(hosted ? [{ address: new URL(HOSTED_WEB_URL).host, link: hosted }] : []),
    ...[...found, ...theirs].flatMap((address) => {
      const link = browserPairingLink(address, payload)
      return link ? [{ address: addressText(address), link }] : []
    }),
  ]
}
