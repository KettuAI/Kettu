// The hosts of Kettu's own services: the account and sharing, the relays, push and the published
// pages, all on kettu.sh, kettu.page or a subdomain of either. With the services off, a computer
// sends them nothing, and this tells their requests apart from the user's own.

import { AccountNetworkError, type AccountFetch } from './account-api'

const KETTU_DOMAINS = ['kettu.sh', 'kettu.page']

/**
 * Whether `url` is on one of Kettu's domains or a subdomain of one, or at one of `origins`, as a
 * development run's own copy of a service.
 */
export function isKettuServiceUrl(url: string, origins: readonly string[] = []): boolean {
  const parsed = URL.parse(url)
  if (!parsed) return false
  // The parser lowercases the host; a trailing dot names the same one.
  const host = parsed.hostname.replace(/\.$/, '')
  if (KETTU_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))) return true
  return (
    parsed.origin !== 'null' &&
    origins.some((origin) => URL.parse(origin)?.origin === parsed.origin)
  )
}

/** `fetch`, refusing as unreachable each request to Kettu's services while `cloud` says they are off. */
export function guardKettuFetch(
  fetch: AccountFetch,
  cloud: () => boolean,
  origins: readonly string[] = [],
): AccountFetch {
  return (url, init) =>
    !cloud() && isKettuServiceUrl(url, origins)
      ? Promise.reject(new AccountNetworkError('Kettu’s services are off on this computer'))
      : fetch(url, init)
}
