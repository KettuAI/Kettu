// The one rule for what the viewer's change pill walks, the same for every kind of artifact: which
// two versions it compares, the places it steps through and the version that last changed each.

import type { ArtifactChanges } from '@shared/artifact-changes'
import { resolvePlace, type ArtifactOutline, type ArtifactPlace } from '@shared/artifact-links'

/** Two versions the pill compares; `since` when it counts from one the user saw, not the one before. */
export interface WalkRange {
  from: number
  to: number
  since: boolean
}

export interface WalkInput {
  /** The newest version. */
  head: number | null
  /** The newest version when the viewer opened this artifact. */
  openedAt: number | null
  /**
   * The version the user had seen when the viewer opened it: null when never, undefined when the
   * host keeps no record.
   */
  seenAtOpen: number | null | undefined
  /** The versions a card that opened the viewer said changed, as it compared them. */
  asked: { from: number; to: number } | null
  /** The last version that arrived while the viewer was open, and the newest before it. */
  arrived: { from: number; to: number } | null
  /** Whether the user wrote the version that arrived, whose changes need no pill. */
  arrivedOwn: boolean
}

/**
 * What the pill compares: a version that arrived while viewing against the one before it; else
 * what the card that opened it compared; else what came since the version the user last saw. Only
 * ever up to the newest version, and nothing for an artifact the user never saw.
 */
export function walkRange(input: WalkInput): WalkRange | null {
  const { head, arrived, asked, seenAtOpen, openedAt } = input
  if (head === null) return null
  const range = (from: number, to: number): WalkRange | null =>
    to === head && from >= 1 && from < to ? { from, to, since: to - from >= 2 } : null
  if (arrived) return input.arrivedOwn ? null : range(arrived.from, arrived.to)
  if (asked) return range(asked.from, asked.to)
  if (seenAtOpen == null || openedAt === null) return null
  return range(seenAtOpen, openedAt)
}

/** A changed place the pill steps to; `key` names it across versions. */
export type WalkPlace =
  | { kind: 'frame'; key: string; id: string; name: string }
  | { kind: 'passage'; key: string; section: string | null; at: number }
  | { kind: 'slide'; key: string; number: number }
  | { kind: 'file'; key: string; path: string }

/** The places in the order the pill walks them; a web page's files are counted, not walked. */
export function walkPlaces(changes: ArtifactChanges): WalkPlace[] {
  switch (changes.kind) {
    case 'frames':
      return changes.frames.map((f) => ({ kind: 'frame', key: f.id, id: f.id, name: f.name }))
    case 'slides':
      return changes.slides.map((s) => ({ kind: 'slide', key: `${s.number}`, number: s.number }))
    case 'sections':
      return changes.passages.map((p) => ({
        kind: 'passage',
        key: `${p.from}`,
        section: p.section,
        at: p.from,
      }))
    case 'files':
      return changes.paths.map((path) => ({ kind: 'file', key: path, path }))
  }
}

/** Whether the arrows step through the places, which a web page of one page has nothing to do. */
export function walks(places: readonly WalkPlace[]): boolean {
  return places.length > 1 && places[0]!.kind !== 'file'
}

/** What carries a version mark: a frame, a document's section, a slide or a file. */
export function markKeys(changes: ArtifactChanges): string[] {
  switch (changes.kind) {
    case 'frames':
      return changes.frames.map((f) => f.id)
    case 'slides':
      return changes.slides.map((s) => `${s.number}`)
    case 'sections':
      return changes.sections.flatMap((s) => (s.slug === null ? [] : [s.slug]))
    case 'files':
      return changes.paths
  }
}

/**
 * The version that last changed each place in a range, from what each step of it changed, oldest
 * first: `steps[i]` is what version `to - steps.length + i + 1` changed against the one before.
 * A place no step names, as when a step could not be compared, takes the range's last version.
 */
export function markVersions(
  range: { to: number },
  total: ArtifactChanges,
  steps: readonly (ArtifactChanges | null)[] | null,
): Map<string, number> {
  const marks = new Map<string, number>()
  const keys = markKeys(total)
  if (steps) {
    const first = range.to - steps.length + 1
    steps.forEach((step, i) => {
      if (!step || step.kind !== total.kind) return
      for (const key of markKeys(step)) marks.set(key, first + i)
    })
  }
  const out = new Map<string, number>()
  for (const key of keys) out.set(key, marks.get(key) ?? range.to)
  return out
}

/** Where the walk starts: at the place asked for when it is among the changes, else the first. */
export function startAt(places: readonly WalkPlace[], key: string | null): number {
  const at = key === null ? -1 : places.findIndex((p) => p.key === key)
  return Math.max(0, at)
}

/** The next place, round from the last to the first and back. */
export function stepFrom(at: number, count: number, direction: 1 | -1): number {
  return count === 0 ? 0 : (at + direction + count) % count
}

/** What a kind marks and walks: the two versions, what changed, the place at and each one's version. */
export interface SheetWalk {
  from: number
  to: number
  changes: ArtifactChanges
  at: number
  marks: ReadonlyMap<string, number>
}

/** A place a kind is asked to bring into view, once per `seq`. */
export interface PlaceAsk {
  seq: number
  /** Flash it once there. */
  flash: boolean
  /** Open a canvas frame at reading size rather than bring it into view. */
  open: boolean
  frame?: string
  slide?: number
  /** A document's section, by its slug, or a block of it, by where it starts. */
  section?: string
  at?: number
}

/**
 * Where a link lands in a version: a slide found by its title's slug, nearest its number when
 * several match, so a link still finds its slide after slides move; by number when it has no slug,
 * none matches, or the version could not be read. Other places land as written.
 */
export function landingPlace(
  place: ArtifactPlace,
  outline: ArtifactOutline | null | undefined,
): ArtifactPlace {
  if (place.kind !== 'slide' || !outline) return place
  const found = resolvePlace(place, outline)
  return found?.kind === 'slide' ? { ...place, number: found.number } : place
}
