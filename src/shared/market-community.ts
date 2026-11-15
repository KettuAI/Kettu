// Installing from the Kettu Marketplace: what the host lists of it, a listing's page, and where an
// installed item stands with its listing. Skills and MCP servers from it are kept like any other,
// with ids of `kettu:` and the listing's id; plugins go through a local marketplace of each harness.

import type { CatalogServer } from './marketplace'
import {
  LISTING_ID,
  type ListingVisibility,
  type MarketListing,
  type PublishHarness,
  type PublishKind,
} from './market-publish'

/** The name of the local marketplace each harness gets the Kettu Marketplace's plugins from. */
export const KETTU_PLUGINS = 'kettu-marketplace'

const KETTU_PREFIX = 'kettu:'

/** The id a skill or MCP server from the listing is kept by. */
export function kettuId(listingId: string): string {
  return `${KETTU_PREFIX}${listingId}`
}

/** The listing a kept skill's or server's id names; null for any other source. */
export function listingIdOf(id: string): string | null {
  if (!id.startsWith(KETTU_PREFIX)) return null
  const rest = id.slice(KETTU_PREFIX.length)
  return LISTING_ID.test(rest) ? rest : null
}

/** One row of the directory's Community or Yours section. */
export interface CommunityItem {
  id: string
  handle: string
  slug: string
  name: string
  kind: PublishKind
  harness?: PublishHarness
  description: string
  visibility: ListingVisibility
  version: string | null
  /** Null for an Only me listing, whose installs are not counted for anyone to see. */
  installs: number | null
  updatedAt: string
}

export interface CommunityDirectory {
  /** False while the host is not signed in to a Kettu account with Kettu's services on. */
  signedIn: boolean
  /** Public listings, most installed first. */
  items: CommunityItem[]
  /** The cursor of the next page; null on the last. */
  next: string | null
  /** The account's own Only me listings, which only its own hosts see. */
  yours: CommunityItem[]
  /** Why the directory, or the account's own listings, could not be read. */
  error: string | null
}

/** A listing's page: what the service says of it, or that it is gone. */
export type CommunityListing =
  | {
      state: 'listed'
      listing: MarketListing
      /** An MCP server's spec, as it would be installed; null when Kettu cannot run it. */
      server: CatalogServer | null
    }
  | { state: 'taken-down' }
  // Deleted, never there, or another account's Only me listing.
  | { state: 'gone' }

/** Where an installed item stands with its listing. */
export type CommunityStanding =
  | { state: 'listed' | 'unlisted'; current: string; versions: string[] }
  | { state: 'taken-down' | 'gone' }
  | { state: 'unknown'; error: string }

/** A plugin installed from the Kettu Marketplace, by the listing it came from. */
export interface CommunityPlugin {
  listingId: string
  harness: PublishHarness
  /** Its name in the harness's local marketplace, so its id there is `<name>@kettu-marketplace`. */
  name: string
  version: string
  handle: string
  slug: string
}

export interface CommunityInstalled {
  plugins: CommunityPlugin[]
  /** By listing id, for every skill, MCP server and plugin installed from the Kettu Marketplace. */
  standings: Record<string, CommunityStanding>
}
