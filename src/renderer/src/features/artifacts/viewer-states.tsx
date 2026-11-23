// The viewer's states besides its content: the wait while it opens, a piece that cannot show, the
// whole artifact failing, and the marks of an agent writing it. The shell never waits for them.

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { Alert02Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { Icon } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/affect/button'
import { useDark } from '@renderer/hooks/use-dark'
import { useArtifactsStore } from '@renderer/stores/artifacts'
import { artifactKind, type ArtifactKind } from './model'
import { KindSketch } from './sketch'
import { usePartThumbnail, useThumbnail } from './thumbnails'
import { usePartThumbnails } from './artifact-host'
import './artifact-card.css'
import './viewer-states.css'

/** A wait shorter than this shows nothing, so a quick load does not flash. */
const WAIT_SHOWN_AFTER_MS = 200

/** Whether the wait that began at `since` has lasted long enough to show. */
function useWaitShown(since: number): boolean {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const timer = setTimeout(
      () => setShown(true),
      Math.max(0, since + WAIT_SHOWN_AFTER_MS - performance.now()),
    )
    return () => clearTimeout(timer)
  }, [since])
  return shown
}

/** One band of light crossing its parent, left to right; still under reduced motion. */
export function LightBand() {
  return <span aria-hidden className="k-vs-band" />
}

/**
 * The content's place while it loads: the card's picture of the artifact, enlarged and soft, with
 * the band of light crossing it. `sheet` fills its place, as a page or a document does; `card`
 * lies in the middle of the ground, as a canvas or a deck does. Nothing within the first 0.2 s.
 */
export function OpeningCover({
  id,
  since,
  look,
}: {
  id: string | null
  since: number
  look: 'sheet' | 'card'
}) {
  const { t } = useTranslation('artifacts')
  const shown = useWaitShown(since)
  if (!shown) return null
  return (
    <div role="status" aria-label={t('viewer.loading')} className="k-vs-cover" data-look={look}>
      <span className="k-vs-cover__in">
        {id ? <CoverPicture id={id} /> : <span className="k-vs-cover__blank" />}
        <LightBand />
      </span>
    </div>
  )
}

function CoverPicture({ id }: { id: string }) {
  const summary = useArtifactsStore((s) => s.list?.find((a) => a.id === id) ?? null)
  const kind = summary ? artifactKind(summary) : null
  const parts = usePartThumbnails(id)
  const thumbnail = useThumbnail(
    {
      id,
      version: summary?.version ?? 0,
      pages: summary?.pages ?? 0,
      canvas: summary?.canvas ?? false,
    },
    summary !== null,
  )
  // A document's sheet follows the theme, so in the dark one its cover does too.
  const darkDoc = useDark() && kind === 'document' && parts && summary !== null
  const dark = usePartThumbnail(id, summary?.version ?? 0, { theme: 'dark' }, darkDoc)
  if (darkDoc && dark.state === 'ready') {
    return <img className="k-vs-cover__pic" src={dark.src} alt="" draggable={false} />
  }
  if (thumbnail.state === 'ready') {
    return <img className="k-vs-cover__pic" src={thumbnail.src} alt="" draggable={false} />
  }
  if (kind && thumbnail.state === 'failed') {
    return (
      <span className="k-vs-cover__pic">
        <KindSketch kind={kind} title={summary?.title ?? ''} />
      </span>
    )
  }
  return <span className="k-vs-cover__blank" />
}

/** A navigator's rows while its content loads. */
export function SkeletonRows({ nested = false }: { nested?: boolean }) {
  const widths = nested ? [58, 46, 66, 54, 42, 60, 50] : [60, 48, 72, 52, 64, 44]
  return (
    <div aria-hidden className="k-vs-skel">
      {widths.map((w, i) => (
        <span
          key={i}
          className="k-vs-skel__row"
          data-nested={nested && i > 0 && i < 6 ? '' : undefined}
        >
          {nested && <i className="k-vs-skel__icon" />}
          <i className="k-bone" style={{ width: `${w}%` }} />
        </span>
      ))}
    </div>
  )
}

/**
 * The whole content's state when it cannot show, or holds nothing: the kind's sketch when it
 * failed, what happened and the next steps, in the middle of the shell, which stays.
 */
export function StageNote({
  kind,
  title,
  text,
  danger = false,
  children,
  quiet,
}: {
  kind: ArtifactKind | null
  title: string
  text: ReactNode
  danger?: boolean
  /** The buttons. */
  children?: ReactNode
  /** A quieter line under them, as handing the repair to an agent. */
  quiet?: ReactNode
}) {
  return (
    <div className="k-vs-note" role={danger ? 'alert' : undefined}>
      {kind && (
        <span aria-hidden className="k-vs-note__sketch">
          <KindSketch kind={kind} title="" />
        </span>
      )}
      <span className="k-vs-note__words">
        <b>{title}</b>
        <span>{text}</span>
      </span>
      {(children || quiet) && (
        <span className="k-vs-note__acts">
          {children && <span className="k-vs-note__row">{children}</span>}
          {quiet}
        </span>
      )}
    </div>
  )
}

/**
 * A piece that cannot show, in its own place: why, with Retry and Ask the agent; only a warning
 * mark where the place is too small on screen for words.
 */
export function PieceFault({
  title,
  reason,
  actions,
  retry,
}: {
  title: string
  reason: ReactNode
  actions: ReactNode
  /** What the mark does where there is no room for the actions. */
  retry?: { label: string; run: () => void }
}) {
  return (
    <div role="alert" className="k-vs-fault">
      <span className="k-vs-fault__in">
        <span aria-hidden className="k-vs-warn">
          <Icon icon={Alert02Icon} size={16} />
        </span>
        <b>{title}</b>
        <span className="k-vs-fault__why">{reason}</span>
        <span className="k-vs-fault__acts">{actions}</span>
      </span>
      {retry ? (
        <button
          type="button"
          className="k-vs-warn k-vs-fault__small"
          title={`${title} · ${retry.label}`}
          aria-label={retry.label}
          onClick={retry.run}
        >
          <Icon icon={Alert02Icon} size={14} />
        </button>
      ) : (
        <span aria-hidden className="k-vs-warn k-vs-fault__small" title={title}>
          <Icon icon={Alert02Icon} size={14} />
        </span>
      )}
    </div>
  )
}

/** The agent writing a piece: its mark and name on an orange tag at the piece's edge. */
export function WriterTag({
  mark,
  name,
  className,
  style,
}: {
  mark: ReactNode
  name: string
  className?: string
  style?: CSSProperties
}) {
  return (
    <span className={className ? `k-vs-writer ${className}` : 'k-vs-writer'} style={style}>
      <span aria-hidden className="k-vs-writer__mark">
        {mark}
      </span>
      {name}
    </span>
  )
}

/** A navigator narrowed to nothing: what it holds, in one line, and the one way back. */
export function NoneHere({ text, onShowAll }: { text: string; onShowAll: (() => void) | null }) {
  const { t } = useTranslation('artifacts')
  return (
    <div className="k-vs-none">
      <span>{text}</span>
      {onShowAll && (
        <Button variant="ghost" size="sm" onClick={onShowAll}>
          {t('viewer.showAll')}
        </Button>
      )}
    </div>
  )
}
