// The links a browser opens a pairing code with, one for each of the host's addresses.

import { addressKey, addressText } from '@shared/remote/address'
import { browserPairingLink, parsePairingLink } from '@shared/remote/pairing'
import type { DirectAddress } from '@shared/remote/protocol'

/**
 * The browser's link for each of the code's addresses that a browser can open, the ones this
 * computer found first: a browser on the same network is the usual one, and the owner's own
 * addresses, such as a forwarded port, often reach it from outside in plain http.
 */
export function browserLinks(
  appLink: string | null,
  own: DirectAddress[],
): { address: string; link: string }[] {
  const payload = appLink ? parsePairingLink(appLink) : null
  if (!payload) return []
  const owned = new Set(own.map(addressKey))
  const found = payload.addresses.filter((address) => !owned.has(addressKey(address)))
  const theirs = payload.addresses.filter((address) => owned.has(addressKey(address)))
  return [...found, ...theirs].flatMap((address) => {
    const link = browserPairingLink(address, payload)
    return link ? [{ address: addressText(address), link }] : []
  })
}
