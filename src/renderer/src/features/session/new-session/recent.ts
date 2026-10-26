import type { ArtifactSummary } from '@shared/artifacts'

/** How many of the artifacts changed last New session shows. */
export const RECENT = 3

const PLACES: readonly null[] = Array.from({ length: RECENT }, () => null)

/**
 * What Recent artifacts holds: the artifacts changed last, or places for them before the first
 * read. With none, or after a failed read, the places stay out of sight, as the cards do while the
 * draft holds a message, so the group keeps its room and the heading and the composer above it
 * never move.
 */
export function recentCards(
  list: readonly ArtifactSummary[] | null,
  failed: boolean,
  hidden: boolean,
): { cards: readonly (ArtifactSummary | null)[]; shown: boolean } {
  const none = list ? list.length === 0 : failed
  return {
    cards: none || !list ? PLACES : list.slice(0, RECENT),
    shown: !hidden && !none,
  }
}
