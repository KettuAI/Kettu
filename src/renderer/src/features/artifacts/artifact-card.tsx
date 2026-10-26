import { memo, useRef, useState } from 'react'
import { EllipsisIcon, GlobeIcon, ImageOffIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ArtifactSummary } from '@shared/artifacts'
import { Button } from '@renderer/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Spinner } from '@renderer/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { longAgo } from '@renderer/lib/format'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { useArtifactsStore } from '@renderer/stores/artifacts'
import { useSharingStore } from '@renderer/stores/sharing'
import { openArtifact } from '@renderer/stores/view'
import { ArtifactMenuItems } from './artifact-menu'
import { useThumbnail, type Thumbnail } from './thumbnails'
import { useInView } from './use-in-view'

/** Opens the viewer; Back returns to the page with this card focused. */
function openFromPage(id: string, history = false): void {
  useArtifactsStore.setState({ opened: id })
  openArtifact(id, { history })
}

// Pointed at, focused or with its menu open, the tray darkens a little and the page lifts; a
// canvas's pages lift less, as they lie flatter.
const TRAY =
  'relative isolate block aspect-16/10 w-full overflow-hidden rounded-code bg-sidebar shadow-sunk transition-colors duration-(--duration-base) group-hover/open:bg-[color-mix(in_srgb,var(--bg-sidebar),var(--text-primary)_2.5%)] group-focus-visible/open:outline-2 group-focus-visible/open:outline-offset-2 group-focus-visible/open:outline-focus group-data-held/card:bg-[color-mix(in_srgb,var(--bg-sidebar),var(--text-primary)_2.5%)]'
const SHEET =
  'absolute inset-[9%] overflow-hidden rounded-xs bg-canvas shadow-(--elevation-page) transition-[translate,box-shadow] duration-(--duration-base) ease-out-quart group-hover/open:shadow-(--elevation-page-lift) group-focus-visible/open:shadow-(--elevation-page-lift) group-data-held/card:shadow-(--elevation-page-lift) motion-safe:group-hover/open:-translate-y-0.5 motion-safe:group-focus-visible/open:-translate-y-0.5 motion-safe:group-data-held/card:-translate-y-0.5 motion-safe:group-active/open:-translate-y-px motion-safe:group-active/open:duration-(--duration-instant)'
const FRAMES =
  'absolute inset-0 transition-[translate] duration-(--duration-base) ease-out-quart motion-safe:group-hover/open:-translate-y-[1.5px] motion-safe:group-focus-visible/open:-translate-y-[1.5px] motion-safe:group-data-held/card:-translate-y-[1.5px]'
// What lies in Recently deleted shows faded.
const FADED = 'opacity-72 grayscale-85'

/**
 * One artifact: a sheet lying in its tray of desk, or a canvas's pages laid out as on the canvas,
 * with the title and caption under it, and its menu. On the page by default; `recent` is New
 * session's card, whose caption ends with when.
 */
export const ArtifactCard = memo(function ArtifactCard({
  artifact,
  lead,
  project,
  session,
  tabbable,
  variant = 'page',
}: {
  artifact: ArtifactSummary
  /** What the grouping hides: the version, the session or the project; in Recently deleted, the
   * project and the days left. */
  lead: string
  project: string
  session: string
  tabbable: boolean
  variant?: 'page' | 'recent'
}) {
  const { t } = useTranslation('artifacts')
  const card = useRef<HTMLDivElement>(null)
  const thumbnail = useThumbnail(artifact, useInView(card))
  const [moreOpen, setMoreOpen] = useState(false)
  const [contextOpen, setContextOpen] = useState(false)
  const shared = useSharingStore(
    (s) => s.status?.published.some((page) => page.id === artifact.id) ?? false,
  )
  const recent = variant === 'recent'
  // Only the page takes the focus back to the card it opened.
  const open = (history = false) =>
    recent ? openArtifact(artifact.id, { history }) : openFromPage(artifact.id, history)
  // The short caption keeps its room for when; the tray shows a canvas's pages anyway.
  const caption = [
    lead,
    !recent && artifact.pages >= 2 && t('card.canvas', { count: artifact.pages }),
  ]
    .filter(Boolean)
    .join(' · ')

  const items = (
    <ArtifactMenuItems
      target={{
        id: artifact.id,
        title: artifact.title,
        version: artifact.version,
        versions: artifact.version,
        sessionId: artifact.sessionId,
        deletedAt: artifact.deletedAt,
      }}
      onOpen={() => open()}
      onVersionHistory={() => open(true)}
    />
  )

  const button = (
    <button
      type="button"
      data-artifact-card={artifact.id}
      tabIndex={tabbable ? 0 : -1}
      onClick={() => open()}
      onKeyDown={(event) => {
        // The context menu key opens the More menu, the card's menu for the keyboard.
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault()
          setMoreOpen(true)
        }
      }}
      className="group/open flex w-full flex-col gap-2.5 text-left outline-none"
    >
      <span className={TRAY}>
        <TrayContent thumbnail={thumbnail} faded={artifact.deletedAt !== null} />
        {artifact.editing.length > 0 && <EditingPill />}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5 pr-9 pl-0.5">
        <span className="truncate text-ui font-medium text-primary">{artifact.title}</span>
        <span className="flex min-w-0 items-center gap-1.25 text-xs text-tertiary tabular-nums">
          {shared && (
            <GlobeIcon
              role="img"
              aria-label={t('card.shared')}
              className="size-3 shrink-0 text-success"
            />
          )}
          <span className="truncate">
            {caption}
            {recent && <Ago at={artifact.updatedAt} />}
          </span>
        </span>
      </span>
    </button>
  )

  return (
    <div
      ref={card}
      data-held={moreOpen || contextOpen || undefined}
      className="group/card relative min-w-0"
    >
      <ContextMenu onOpenChange={setContextOpen}>
        <Tooltip>
          <TooltipTrigger render={<ContextMenuTrigger render={button} />} delay={700} />
          <TooltipContent className="flex-col items-start gap-0.5">
            <span>{project}</span>
            <span>{session}</span>
            <CardTime artifact={artifact} />
          </TooltipContent>
        </Tooltip>
        <ContextMenuContent>{items}</ContextMenuContent>
      </ContextMenu>
      {/* Over the caption's end, so the title keeps its width; the card's Tab stop is its own. */}
      <DropdownMenu open={moreOpen} onOpenChange={setMoreOpen}>
        <DropdownMenuTrigger
          render={
            <Button
              variant="quiet"
              size="icon-sm"
              tabIndex={-1}
              aria-label={t('card.more', { title: artifact.title })}
              className="absolute -right-1 bottom-1 opacity-0 transition-opacity duration-(--duration-fast) group-focus-within/card:opacity-100 group-hover/card:opacity-100 data-popup-open:opacity-100"
            />
          }
        >
          <EllipsisIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">{items}</DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
})

/** What lies in the tray: a page as a sheet, a canvas's pages where they lie, or why neither. */
function TrayContent({ thumbnail, faded }: { thumbnail: Thumbnail; faded: boolean }) {
  const { t } = useTranslation('artifacts')
  if (thumbnail.state === 'loading') return <Skeleton className="absolute inset-[9%] rounded-xs" />
  if (thumbnail.state === 'failed') {
    return (
      <span className="absolute inset-[9%] flex flex-col items-center justify-center gap-1.5 rounded-xs border-[1.5px] border-dashed border-strong text-xs text-tertiary">
        <ImageOffIcon className="size-3.5" />
        {t('card.noPreview')}
      </span>
    )
  }
  const fade = 'animate-in fade-in duration-(--duration-fast)'
  if (!thumbnail.pages) {
    return (
      <span className={cn(SHEET, fade, faded && FADED)}>
        <img src={thumbnail.src} alt="" draggable={false} className="size-full object-cover" />
      </span>
    )
  }
  // The image draws the pages on a clear ground; each page takes its edge and shadow over it.
  return (
    <span className={cn(FRAMES, fade, faded && FADED)}>
      <img src={thumbnail.src} alt="" draggable={false} className="size-full object-cover" />
      {thumbnail.pages.map((page, i) => (
        <span
          key={i}
          aria-hidden
          className="absolute shadow-[0_0_0_var(--hairline)_var(--border-default),var(--elevation-card)]"
          style={{
            left: `${page.left * 100}%`,
            top: `${page.top * 100}%`,
            width: `${page.width * 100}%`,
            height: `${page.height * 100}%`,
          }}
        />
      ))}
    </span>
  )
}

/** While a session's running turn changes the artifact. */
function EditingPill() {
  const { t } = useTranslation('artifacts')
  return (
    <span className="absolute top-2 left-2 z-2 flex h-5.5 items-center gap-1.5 rounded-full bg-surface pr-2 pl-1.5 text-xs font-medium text-secondary shadow-card">
      <Spinner className="size-3" />
      {t('card.editing')}
    </span>
  )
}

/** The caption's time, apart so only it follows the clock. */
function Ago({ at }: { at: number }) {
  const now = useNow()
  return <> · {longAgo(at, now)}</>
}

/** In the tooltip only, so it reads the time as it opens. */
function CardTime({ artifact }: { artifact: ArtifactSummary }) {
  const { t } = useTranslation('artifacts')
  const now = useNow()
  return (
    <span>
      {t('card.when', { version: artifact.version, time: longAgo(artifact.updatedAt, now) })}
    </span>
  )
}

/** A card's place before the list arrives, at its real size. */
export function CardSkeleton({ variant = 'page' }: { variant?: 'page' | 'recent' }) {
  return (
    <div aria-hidden className="flex min-w-0 flex-col gap-2.5">
      <Skeleton className="aspect-16/10 w-full rounded-code" />
      <div className="flex flex-col pr-9 pl-0.5">
        <Skeleton className="mt-1 h-3 w-[62%]" />
        {/* The recent card's caption, a project and a time, runs longer than a version. */}
        <Skeleton className={cn('mt-1.5 h-2.5', variant === 'recent' ? 'w-[48%]' : 'w-[34%]')} />
      </div>
    </div>
  )
}
