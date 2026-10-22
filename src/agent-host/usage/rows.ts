// The rule for a row imported again under the same key, shared by the database and the tests.

import { rowTotal, type UsageRow } from './model'

/**
 * Whether `next` replaces `stored`: a message read half-written grows when a later scan finds
 * more of it, and nothing else changes a stored row.
 */
export function keepsNewer(stored: UsageRow, next: UsageRow): boolean {
  if (next.output !== stored.output) return next.output > stored.output
  return rowTotal(next) > rowTotal(stored)
}
