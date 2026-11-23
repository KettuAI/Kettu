import { useEffect, useMemo, useState } from 'react'
import type { ArtifactChanges } from '@shared/artifact-changes'
import type { ArtifactPlace } from '@shared/artifact-links'
import type { ArtifactSummary, VersionSummary } from '@shared/artifacts'
import { changesOf, useChanges } from '@renderer/features/session/entries/artifact-changes'
import {
  landingTaken,
  setWalkAt,
  setWalkRange,
  useArtifactWalk,
  type Landing,
} from '@renderer/stores/artifact-walk'
import {
  markVersions,
  startAt,
  stepFrom,
  walkPlaces,
  walkRange,
  walks,
  type PlaceAsk,
  type WalkPlace,
  type WalkRange,
} from './change-walk'

/** Above this many versions in a range, every change is marked with the newest. */
const MARKED_STEPS = 8

export interface ChangeWalk {
  range: WalkRange
  changes: ArtifactChanges
  places: WalkPlace[]
  /** Whether the arrows step through the places. */
  steps: boolean
  at: number
  /** The version that last changed each place, by its key. */
  marks: ReadonlyMap<string, number>
  /** The pill was put away; the marks stay. */
  dismissed: boolean
  dismiss: () => void
}

let asks = 0

/** Where a place lies, as the kind that shows it is asked for it. */
function askFor(place: WalkPlace | ArtifactPlace, open: boolean): PlaceAsk | null {
  const ask = { seq: --asks, flash: true, open }
  switch (place.kind) {
    case 'frame':
      return { ...ask, frame: place.id }
    case 'slide':
      return { ...ask, slide: place.number }
    case 'passage':
      return { ...ask, at: place.at }
    case 'section':
      return { ...ask, section: place.slug }
    case 'file':
      return null
  }
}

/** The key a place the walk holds goes by, for a place a link or a card names. */
function keyOf(place: ArtifactPlace): string {
  return place.kind === 'frame' ? place.id : place.kind === 'slide' ? `${place.number}` : place.slug
}

/**
 * The viewer's walk through what changed, by the one rule `walkRange` keeps, and where it lands:
 * on what a card or a link asked for, else on the first change when versions came since the user
 * last saw it. A version that arrives while viewing shows the pill and moves nothing.
 */
export function useChangeWalk({
  id,
  panel,
  summary,
  versions,
  ready,
  positioned,
  latest,
}: {
  id: string
  /** The panel the viewer shows in, as landings name it. */
  panel: string
  summary: ArtifactSummary | null
  versions: VersionSummary[] | null
  /** Whether the content is on screen, so a landing can take place. */
  ready: boolean
  /** Whether something else asked where it opens, such as a page flipped to on a card. */
  positioned: boolean
  /** Whether the newest version is shown, not an earlier one or a deleted artifact. */
  latest: boolean
}): {
  walk: ChangeWalk | null
  /** The place the content is asked to bring into view, until `done`. */
  ask: PlaceAsk | null
  done: (seq: number) => void
  step: (direction: 1 | -1, open: boolean) => void
} {
  const head = summary?.version ?? null
  // What the user had seen when this viewer opened it, before opening it marks it seen.
  const [opened, setOpened] = useState<{
    id: string
    head: number
    seen: number | null | undefined
  } | null>(null)
  if (summary && opened?.id !== id) setOpened({ id, head: summary.version, seen: summary.seen })
  const openedNow = opened?.id === id ? opened : null

  // A version that arrives while the viewer is open.
  const [arrived, setArrived] = useState<{ id: string; from: number; to: number } | null>(null)
  const [lastHead, setLastHead] = useState<{ id: string; head: number | null }>({ id, head })
  if (lastHead.id !== id || lastHead.head !== head) {
    const was = lastHead.head
    if (lastHead.id === id && was !== null && head !== null && head > was) {
      setArrived({ id, from: was, to: head })
    } else if (lastHead.id !== id) setArrived(null)
    setLastHead({ id, head })
  }
  const arrivedNow = arrived?.id === id ? arrived : null
  // Who wrote it is known once the versions are read again; until then it shows no pill.
  const arrivedBy = arrivedNow ? versions?.find((v) => v.version === arrivedNow.to) : undefined

  const landing = useArtifactWalk((s) => {
    const asked = s.landings[panel]
    return asked?.artifactId === id ? asked : null
  })
  const [asked, setAsked] = useState<Landing | null>(null)
  if (landing && landing.seq !== asked?.seq) {
    setAsked(landing)
    // A newer ask counts from its card, not from a version that arrived before it.
    setArrived(null)
  }
  const askedNow = asked?.artifactId === id ? asked : null
  useEffect(() => {
    if (landing) landingTaken(panel, landing.seq)
  }, [landing, panel])

  const range = useMemo(
    () =>
      walkRange({
        head,
        openedAt: openedNow?.head ?? null,
        seenAtOpen: openedNow?.seen,
        asked: askedNow?.range ?? null,
        arrived: arrivedNow,
        // A version the user wrote, or one not yet known to be someone else's.
        arrivedOwn: arrivedNow !== null && (arrivedBy === undefined || arrivedBy.author === null),
      }),
    [head, openedNow, askedNow, arrivedNow, arrivedBy],
  )
  const rangeKey = range ? `${id}:${range.from}:${range.to}` : null

  const changes = useChanges(id, range?.from ?? null, range?.to ?? null, range !== null && latest)
  const places = useMemo(() => (changes ? walkPlaces(changes) : []), [changes])

  // Each version's own changes in a range of several, for the version each place carries.
  const [stepsOf, setStepsOf] = useState<{
    key: string
    steps: (ArtifactChanges | null)[]
  } | null>(null)
  useEffect(() => {
    if (!range || !range.since || range.to - range.from > MARKED_STEPS || !latest) return
    let live = true
    const key = `${id}:${range.from}:${range.to}`
    const pairs = Array.from({ length: range.to - range.from }, (_, i) => range.from + i)
    void Promise.all(pairs.map((from) => changesOf(id, from, from + 1))).then((steps) => {
      if (live) setStepsOf({ key, steps })
    })
    return () => {
      live = false
    }
  }, [id, range, latest])
  const steps = stepsOf && stepsOf.key === rangeKey ? stepsOf.steps : null
  const marks = useMemo(
    () => (range && changes ? markVersions(range, changes, steps) : new Map<string, number>()),
    [range, changes, steps],
  )

  const [at, setAt] = useState<{ key: string | null; at: number }>({ key: null, at: 0 })
  const atNow = at.key === rangeKey ? at.at : 0
  const [dismissed, setDismissed] = useState<string | null>(null)
  // Whether the card's frame that opened the walk is ringed, which then follows the pill.
  const [ringed, setRinged] = useState<string | null>(null)

  const [ask, setAsk] = useState<PlaceAsk | null>(null)

  // Landing, once per opening and per ask: on the place asked for, else the first change. A range
  // still being compared waits for what changed.
  const [landedFor, setLandedFor] = useState<string | null>(null)
  const landKey = `${id}:${askedNow?.seq ?? 'open'}`
  if (ready && landedFor !== landKey && !(range && changes === undefined && latest)) {
    setLandedFor(landKey)
    const place = askedNow?.place ?? null
    const index = place ? places.findIndex((p) => p.key === keyOf(place)) : -1
    if (place) {
      if (index >= 0) setAt({ key: rangeKey, at: index })
      setRinged(askedNow?.open && index >= 0 ? rangeKey : null)
      setAsk(askFor(place, askedNow?.open ?? false))
    } else {
      setRinged(null)
      // A version that arrived, a place asked for elsewhere, or nothing changed: it lands nowhere.
      if (range && !arrivedNow && !positioned && places.length > 0) {
        const first = startAt(places, null)
        setAt({ key: rangeKey, at: first })
        setAsk(askFor(places[first]!, false))
      }
    }
  }

  const shown = !!range && !!changes && places.length > 0 && latest && dismissed !== rangeKey
  // The change the pill is at, which the card that opened the viewer rings.
  const current = shown && ringed === rangeKey ? (places[atNow]?.key ?? null) : null
  useEffect(() => {
    setWalkAt(id, current)
  }, [id, current])
  useEffect(() => () => setWalkAt(id, null), [id])
  const shownFrom = shown ? range.from : null
  const shownTo = shown ? range.to : null
  useEffect(() => {
    setWalkRange(
      id,
      shownFrom !== null && shownTo !== null ? { from: shownFrom, to: shownTo } : null,
    )
  }, [id, shownFrom, shownTo])
  useEffect(() => () => setWalkRange(id, null), [id])

  const walk: ChangeWalk | null =
    range && changes && places.length > 0 && latest
      ? {
          range,
          changes,
          places,
          steps: walks(places),
          at: atNow,
          marks,
          dismissed: dismissed === rangeKey,
          dismiss: () => setDismissed(rangeKey),
        }
      : null

  return {
    walk,
    ask,
    done: (seq) => setAsk((was) => (was?.seq === seq ? null : was)),
    step: (direction, open) => {
      if (!walk) return
      const next = stepFrom(atNow, places.length, direction)
      setAt({ key: rangeKey, at: next })
      setAsk(askFor(places[next]!, open))
    },
  }
}
