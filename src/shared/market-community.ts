// Installing from the Kettu Marketplace: what the host lists of it, a listing's page, and where an
// installed item stands with its listing. Skills and MCP servers from it are kept like any other,
// with ids of `kettu:` and the listing's id; workflows go into the workflow library, which records the
// listing and version.

import type { CatalogServer } from './marketplace'
import type { Workflow } from './workflow'
import {
  LISTING_ID,
  type ListingVisibility,
  type MarketListing,
  type PublishAdds,
  type PublishHarness,
  type PublishKind,
} from './market-publish'

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
  /** Published by Kettu's own publisher. */
  official: boolean
  version: string | null
  /** Null for an Only me listing, whose installs are not counted for anyone to see. */
  installs: number | null
  updatedAt: string
  /** A workflow's step names in order and those that wait for the user, as its publisher's check listed them. */
  steps?: string[]
  waits?: string[]
  /** What a plugin's version holds, as its publisher's check listed it; only for a plugin. */
  adds?: PublishAdds[]
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
      /** An MCP server's bundle, installed in two steps; null when it has none. */
      bundle: BundleRef | null
    }
  | { state: 'taken-down' }
  // Deleted, never there, or another account's Only me listing.
  | { state: 'gone' }

/**
 * A workflow listing's flow as its current version's `workflow.yaml` reads, for its page before it
 * is added; null with why when the file is missing or the workflow format refuses it.
 */
export type CommunityWorkflow =
  | { version: string; workflow: Workflow; problem: null }
  | { version: string; workflow: null; problem: string }

/** Where an installed item stands with its listing. */
export type CommunityStanding =
  | { state: 'listed' | 'unlisted'; current: string; versions: string[] }
  | { state: 'taken-down' | 'gone' }
  | { state: 'unknown'; error: string }

export interface CommunityInstalled {
  /** Always empty: clients from before Kettu stopped installing harness plugins require the field. */
  plugins: never[]
  /** By listing id, for every skill, workflow and MCP server installed from the Kettu Marketplace. */
  standings: Record<string, CommunityStanding>
}

/**
 * An MCP bundle (`.mcpb`) a server listing installs from: the version's own uploaded file, or an
 * https `mcpb` package its `server.json` names with the SHA-256 the file must have.
 */
export type BundleRef =
  | { from: 'upload'; path: string; size: number; sha256: string }
  | { from: 'url'; url: string; sha256: string }

/** What a bundle runs as. */
export type BundleType = 'node' | 'python' | 'uv' | 'binary'

/** A value the bundle asks for, from its manifest's `user_config`, in the manifest's order. */
export interface BundleInput {
  /** Its key in the manifest. */
  key: string
  title: string
  description?: string
  type: 'string' | 'number' | 'boolean' | 'directory' | 'file'
  secret: boolean
  required: boolean
  multiple: boolean
  default?: string
  min?: number
  max?: number
  /** The environment variable it fills, whose value the key store keeps; null when it fills none. */
  env: string | null
  /** Whether it is written into the stored arguments; never for a secret. */
  args: boolean
}

/** A bundle unpacked on the host and checked, waiting for Install; nothing of it has run. */
export interface BundlePlan {
  /** Names the unpacked folder for bundleCommit or bundleCancel; null when it cannot install. */
  token: string | null
  name: string
  version: string
  type: BundleType
  /** What will run, without any value the user fills in. */
  runs: string
  inputs: BundleInput[]
  /** Why it cannot run on this host; Install stays off. */
  blocked: string | null
  /** The values the arguments were given last time, by key, for an update. */
  previous: Record<string, string> | null
}
