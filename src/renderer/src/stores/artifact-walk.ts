import { create } from 'zustand'
import type { ArtifactPlace } from '@shared/artifact-links'

// Where a way into an artifact asks its viewer to land, and the change the viewer's pill is at,
// which the thread's card that opened it rings. Not persisted.

/** What a card or a link asked the viewer of a panel for, once, until the viewer takes it. */
export interface Landing {
  artifactId: string
  /** The versions a card compared, which the pill then walks. */
  range: { from: number; to: number } | null
  /** Where to land, else the first change. */
  place: ArtifactPlace | null
  /** Open a canvas frame at reading size, rather than bring it into view. */
  open: boolean
  seq: number
}

interface WalkStore {
  /** By panel: a session's id, or the main area's. */
  landings: Record<string, Landing>
  /** By artifact: the key of the change the pill is at, while one walks its changes. */
  at: Record<string, string>
  /** By artifact: the versions its pill counts, while one shows, which before and after compares. */
  ranges: Record<string, { from: number; to: number }>
}

export const useArtifactWalk = create<WalkStore>(() => ({ landings: {}, at: {}, ranges: {} }))

let seq = 0

/** Asks the viewer in `panel` to land on a place of the artifact, or on what a card compared. */
export function landArtifact(
  panel: string,
  artifactId: string,
  {
    range = null,
    place = null,
    open = false,
  }: { range?: Landing['range']; place?: ArtifactPlace | null; open?: boolean } = {},
): void {
  useArtifactWalk.setState((s) => ({
    landings: { ...s.landings, [panel]: { artifactId, range, place, open, seq: ++seq } },
  }))
}

/** The viewer took the landing it was asked for. */
export function landingTaken(panel: string, taken: number): void {
  useArtifactWalk.setState((s) => {
    if (s.landings[panel]?.seq !== taken) return s
    const landings = { ...s.landings }
    delete landings[panel]
    return { landings }
  })
}

export function setWalkAt(artifactId: string, key: string | null): void {
  useArtifactWalk.setState((s) => {
    if ((s.at[artifactId] ?? null) === key) return s
    const at = { ...s.at }
    if (key === null) delete at[artifactId]
    else at[artifactId] = key
    return { at }
  })
}

export function setWalkRange(artifactId: string, range: { from: number; to: number } | null): void {
  useArtifactWalk.setState((s) => {
    const was = s.ranges[artifactId]
    if (was?.from === range?.from && was?.to === range?.to) return s
    const ranges = { ...s.ranges }
    if (range === null) delete ranges[artifactId]
    else ranges[artifactId] = { from: range.from, to: range.to }
    return { ranges }
  })
}
