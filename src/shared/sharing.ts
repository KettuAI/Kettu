// Artifacts shared online: the account main publishes with and the pages it published.

/** Cloudflare's account IDs: 32 hex characters. */
export const CLOUDFLARE_ACCOUNT_ID = /^[0-9a-f]{32}$/

/** An API token as a header can carry it: printable ASCII without spaces. */
export const CLOUDFLARE_TOKEN = /^[\x21-\x7e]{1,256}$/

/**
 * Where to create the API token: Cloudflare's form for a new one, with Workers Scripts Edit on every
 * account and the name Kettu filled in, so the user only creates it and copies it.
 */
export const CLOUDFLARE_TOKENS_URL =
  'https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22edit%22%7D%5D&accountId=%2A&zoneId=all&name=Kettu'

/** Where an account picks its `workers.dev` subdomain. */
export const CLOUDFLARE_DASHBOARD_URL = 'https://dash.cloudflare.com/'

/** Workers an account on Cloudflare's free plan can have at once. */
export const CLOUDFLARE_FREE_WORKERS = 100

export interface CloudflareAccount {
  accountId: string
  /** The account's subdomain of `workers.dev`, which every page's URL ends in. */
  subdomain: string
  /** The token is stored without the system's encryption, as on Linux without a keyring. */
  plainText: boolean
}

export interface PublishedArtifact {
  id: string
  url: string
  /** The version the page shows. */
  version: number
  publishedAt: number
  /** Published with another account than the one connected, which cannot change it. */
  otherAccount: boolean
}

/** An account a token can publish to, for the user to choose from. */
export interface CloudflareAccountChoice {
  id: string
  name: string
  /** The account's `workers.dev` subdomain; null when it has none. */
  subdomain: string | null
}

/** What `sharing:status` and `sharing:changed` carry; the token never leaves main. */
export interface SharingStatus {
  cloudflare: CloudflareAccount | null
  published: PublishedArtifact[]
}

/**
 * Why a sharing call failed. `invalid_token`: Cloudflare refused the token, or it reaches no account
 * it can publish to. `no_subdomain`: the account has no `workers.dev` subdomain. `worker_limit`: the
 * account has as many Workers as its plan allows. `network`: Cloudflare could not be reached.
 * `no_account`: no account is connected. `other_account`: the page was published with another
 * account. `encryption`: the system cannot encrypt the token. `not_found`: the host does not have
 * the artifact or version. `unavailable`: the host did not answer. `failed`: anything else, with
 * Cloudflare's own words.
 */
export type SharingFailure =
  | 'invalid_token'
  | 'no_subdomain'
  | 'worker_limit'
  | 'network'
  | 'no_account'
  | 'other_account'
  | 'encryption'
  | 'not_found'
  | 'unavailable'
  | 'failed'

export type SharingResult =
  { status: SharingStatus } | { failed: SharingFailure; message: string | null }

/** What a connect answers: the account kept, a failure, or the accounts the token reaches. */
export type SharingConnectResult = SharingResult | { accounts: CloudflareAccountChoice[] }
