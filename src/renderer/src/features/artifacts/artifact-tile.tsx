// What the Artifacts page's card shows beyond the thread's: what a canvas or a deck holds, the
// changes since the user last opened it, and a flip through its pages or slides under the pointer.

import {
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { useTranslation } from 'react-i18next'
import type { ArtifactChanges } from '@shared/artifact-changes'
import type { ThumbnailPart } from '@shared/artifacts'
import { useDark } from '@renderer/hooks/use-dark'
import type { Outline, OutlineFrame } from './card-contents'
import type { ArtifactKind } from './model'
import { usePartThumbnail } from './thumbnails'

/** Where a click on the card opens it: a canvas page, by the id of its first frame, or a slide. */
export interface OpenAt {
  page?: string
  /** A deck's slide, from 1. */
  slide?: number
}

/** The most frames a canvas card lays side by side. */
const FRAMES_SHOWN = 4
/** Above this many pages the flip's bar is one track with a mark, not a segment each. */
const SEGMENTS = 30

/** The frames as they lie in the card's 16:10 page: shares of its width and height. */
function frameBoxes(frames: readonly OutlineFrame[]): { width: number; height: number }[] {
  const ratios = frames.map((f) => (f.width > 0 && f.height > 0 ? f.width / f.height : 1))
  const gap = 0.032 * 1.6
  const room = 1.6 * 0.9 - gap * (frames.length - 1)
  const height = Math.min(0.74, room / ratios.reduce((sum, r) => sum + r, 0))
  return ratios.map((r) => ({ width: (r * height) / 1.6, height }))
}

/** One part's picture over a blank sheet while it is drawn; nothing when it cannot be. */
function Part({
  id,
  version,
  part,
  inView,
  onFailed,
}: {
  id: string
  version: number
  part: ThumbnailPart
  inView: boolean
  onFailed?: () => void
}) {
  const made = usePartThumbnail(id, version, part, inView)
  const failed = made.state === 'failed'
  const told = useRef(false)
  useLayoutEffect(() => {
    if (failed && !told.current) {
      told.current = true
      onFailed?.()
    }
  }, [failed, onFailed])
  if (made.state !== 'ready') return null
  return <img src={made.src} alt="" draggable={false} />
}

/** A few frames side by side on the canvas's dot ground; `fallback` when none can be drawn. */
function FramesThumb({
  id,
  version,
  frames,
  inView,
  fallback,
}: {
  id: string
  version: number
  frames: readonly OutlineFrame[]
  inView: boolean
  fallback: ReactNode
}) {
  const shown = frames.slice(0, FRAMES_SHOWN)
  const [failed, setFailed] = useState(0)
  const key = shown.map((f) => f.id).join()
  const [failedFor, setFailedFor] = useState(key)
  if (failedFor !== key) {
    setFailedFor(key)
    setFailed(0)
  }
  if (shown.length === 0 || failed >= shown.length) return fallback
  const boxes = frameBoxes(shown)
  return (
    <span className="k-th k-tile-frames">
      {shown.map((frame, i) => (
        <span
          key={frame.id}
          className="k-tile-frames__frame"
          style={{ width: `${boxes[i]!.width * 100}%`, height: `${boxes[i]!.height * 100}%` }}
        >
          <Part
            id={id}
            version={version}
            part={{ frame: frame.id }}
            inView={inView}
            onFailed={() => setFailed((n) => n + 1)}
          />
        </span>
      ))}
    </span>
  )
}

/** A slide with the edges of up to two more behind it; `fallback` when the front cannot be drawn. */
function DeckThumb({
  id,
  version,
  slides,
  inView,
  fallback,
}: {
  id: string
  version: number
  /** From 1, the front one first. */
  slides: readonly number[]
  inView: boolean
  fallback: ReactNode
}) {
  const [frontFailed, setFrontFailed] = useState<number | null>(null)
  const front = slides[0]
  if (front === undefined || frontFailed === front) return fallback
  const behind = slides.slice(1, 3)
  return (
    <span className="k-th k-tile-deck">
      {[behind[1], behind[0]].map((n, i) => (
        <span key={i} className="k-tile-deck__slide" data-depth={2 - i}>
          {n !== undefined && (
            <Part id={id} version={version} part={{ slide: n }} inView={inView} />
          )}
        </span>
      ))}
      <span className="k-tile-deck__slide" data-depth={0}>
        <Part
          key={front}
          id={id}
          version={version}
          part={{ slide: front }}
          inView={inView}
          onFailed={() => setFrontFailed(front)}
        />
      </span>
    </span>
  )
}

/** A document as the viewer draws it in the dark theme; `fallback`, the light one, otherwise. */
export function DarkDocument({
  id,
  version,
  inView,
  fallback,
}: {
  id: string
  version: number
  inView: boolean
  fallback: ReactNode
}) {
  const made = usePartThumbnail(id, version, { theme: 'dark' }, inView)
  if (made.state !== 'ready') return fallback
  return (
    <span className="k-th k-th--image">
      <img src={made.src} alt="" draggable={false} />
    </span>
  )
}

function framesOf(outline: Outline | null | undefined, ids: readonly string[]): OutlineFrame[] {
  if (outline?.kind !== 'canvas') return []
  const all = new Map(outline.pages.flatMap((p) => p.frames).map((f) => [f.id, f]))
  return ids.flatMap((frame) => all.get(frame) ?? [])
}

/** How many pages or slides a flip steps through; 0 when there is nothing to flip. */
function flipCount(outline: Outline | null | undefined): number {
  const count =
    outline?.kind === 'canvas'
      ? outline.pages.length
      : outline?.kind === 'slides'
        ? outline.slides
        : 0
  return count > 1 ? count : 0
}

/**
 * The card's page: what changed since the user last opened it when they have not, else the first
 * of what it holds; under the pointer, the page or slide it points at. Everything else, and every
 * host that draws no parts, falls back to the version's own thumbnail, `whole`.
 */
export function TileThumb({
  id,
  version,
  kind,
  outline,
  changes,
  parts,
  inView,
  whole,
  opensAtRef,
}: {
  id: string
  version: number
  kind: ArtifactKind | null
  outline: Outline | null | undefined
  /** What changed since the version the user last opened, when it is not this one. */
  changes: ArtifactChanges | null | undefined
  /** Whether the artifact's host draws a frame, slide or theme on its own. */
  parts: boolean
  inView: boolean
  whole: ReactNode
  /** Set to where the card opens while the pointer flips it. */
  opensAtRef: RefObject<OpenAt | null>
}) {
  const { t } = useTranslation('artifacts')
  const dark = useDark()
  const [pointed, setAt] = useState<number | null>(null)
  const steps = parts ? flipCount(outline) : 0
  const at = pointed !== null && pointed < steps ? pointed : null
  const label =
    at === null
      ? ''
      : outline?.kind === 'canvas'
        ? outline.pages[at]!.name
        : t('card.slideOf', { number: at + 1, count: steps })
  const changedFrames =
    changes?.kind === 'frames'
      ? framesOf(
          outline,
          changes.frames.map((f) => f.id),
        )
      : []

  let shown: ReactNode = whole
  if (at !== null) {
    if (outline?.kind === 'canvas') {
      shown = (
        <FramesThumb
          id={id}
          version={version}
          frames={outline.pages[at]!.frames}
          inView={inView}
          fallback={whole}
        />
      )
    } else if (outline?.kind === 'slides') {
      const n = at + 1
      shown = (
        <DeckThumb
          id={id}
          version={version}
          slides={[n, n + 1, n + 2].filter((s) => s <= outline.slides)}
          inView={inView}
          fallback={whole}
        />
      )
    }
  } else if (parts && changedFrames.length > 0) {
    shown = (
      <FramesThumb
        id={id}
        version={version}
        frames={changedFrames}
        inView={inView}
        fallback={whole}
      />
    )
  } else if (parts && changes?.kind === 'slides' && changes.slides.length > 0) {
    shown = (
      <DeckThumb
        id={id}
        version={version}
        slides={changes.slides.map((s) => s.number)}
        inView={inView}
        fallback={whole}
      />
    )
  } else if (parts && outline?.kind === 'canvas') {
    shown = (
      <FramesThumb
        id={id}
        version={version}
        frames={outline.pages[0]!.frames}
        inView={inView}
        fallback={whole}
      />
    )
  } else if (parts && outline?.kind === 'slides') {
    shown = (
      <DeckThumb
        id={id}
        version={version}
        slides={[1, 2, 3].filter((s) => s <= outline.slides)}
        inView={inView}
        fallback={whole}
      />
    )
  } else if (parts && kind === 'document' && dark) {
    shown = <DarkDocument id={id} version={version} inView={inView} fallback={whole} />
  }

  const flip =
    steps > 0
      ? {
          onPointerMove: (event: PointerEvent<HTMLSpanElement>) => {
            if (event.pointerType === 'touch') return
            const box = event.currentTarget.getBoundingClientRect()
            const share = (event.clientX - box.left) / box.width
            const next = Math.min(steps - 1, Math.max(0, Math.floor(share * steps)))
            if (next === at) return
            setAt(next)
            opensAtRef.current =
              outline?.kind === 'canvas'
                ? { page: outline.pages[next]!.frames[0]!.id }
                : outline?.kind === 'slides'
                  ? { slide: next + 1 }
                  : null
          },
          onPointerLeave: () => {
            setAt(null)
            opensAtRef.current = null
          },
        }
      : null

  return (
    <span className="k-tile-flip" {...flip}>
      {shown}
      {steps > 0 && at !== null && (
        <>
          <span className="k-tile-flip__label">{label}</span>
          <span className="k-tile-flip__bar" aria-hidden data-track={steps > SEGMENTS || undefined}>
            {steps > SEGMENTS ? (
              <i style={{ left: `${(at / steps) * 100}%`, width: `${100 / steps}%` }} />
            ) : (
              Array.from({ length: steps }, (_, i) => <i key={i} data-on={i === at || undefined} />)
            )}
          </span>
        </>
      )}
    </span>
  )
}
