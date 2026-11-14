// The `item` keys of the Marketplace pages Published adds, and their names for the history.

import type { MarketPublished } from '@shared/market-publish'

/** The `item` of Kettu's own MCP server's page. */
export const KETTU_ITEM = 'builtin:kettu'

const PUBLISHED_PREFIX = 'published:'

/** The `item` of one of the account's own listings. */
export function publishedItem(id: string): string {
  return `${PUBLISHED_PREFIX}${id}`
}

export function publishedIdOf(item: string): string | null {
  return item.startsWith(PUBLISHED_PREFIX) ? item.slice(PUBLISHED_PREFIX.length) || null : null
}

/**
 * A page's name for the history: one of the account's listings, null while it is not known, or
 * Kettu's server; undefined for any other item.
 */
export function publishedTitle(
  published: MarketPublished | null,
  item: string,
): string | null | undefined {
  if (item === KETTU_ITEM) return 'Kettu'
  const id = publishedIdOf(item)
  if (id === null) return undefined
  return published?.mine?.listings.find((listing) => listing.id === id)?.name ?? null
}
