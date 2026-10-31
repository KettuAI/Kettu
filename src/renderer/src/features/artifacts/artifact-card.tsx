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
import { KIND_LOOK } from './kinds'
import { artifactKind } from './model'
import { useThumbnail, type Thumbnail } from './thumbnails'
import { useInView } from './use-in-view'

/** Opens the viewer; Back returns to the page with this card focused. */
function openFromPage(id: string, history = false): void {
  useArtifactsStore.setState({ opened: id })
  openArtifact(id, { history })
}

// Pointed at, focused or with its menu open, the card's border darkens.
const CARD =
  'group/open flex w-full flex-col overflow-hidden border border-default bg-app text-left outline-none transition-colors duration-(--duration-fast) hover:border-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus group-data-held/card:border-strong'
// The artifact's page stands on the band, cut by its lower edge.
// A canvas's pages lie on its ground, under the fade with the rest of the frame.
const PAGE = 'relative min-w-0 flex-1 overflow-hidden border border-b-0 border-default'
// What lies in Recently deleted shows faded.
const FADED = 'opacity-72 grayscale-85'

/** When the card says it was last seen: opened on this device, or its latest version. */
export interface CardTime {
  at: number
  opened: boolean
}

/**
 * One artifact: its page on a band, then its title and caption, and its menu. On the page the band
 * takes its kind's tint, under the kind's icon; `recent` is New session's smaller card.
 */
export const ArtifactCard = memo(function ArtifactCard({
  artifact,
  lead,
  time,
  project,
  session,
  tabbable,
  variant = 'page',
}: {
  artifact: ArtifactSummary
  /** The caption before the time: the project, or the version when grouped; in Recently deleted,
   * the project and the days left. */
  lead: string
  time: CardTime | null
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
  const kind = artifactKind(artifact)
  const look = KIND_LOOK[kind]
  // Only the page takes the focus back to the card it opened.
  const open = (history = false) =>
    recent ? openArtifact(artifact.id, { history }) : openFromPage(artifact.id, history)

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
      className={cn(CARD, recent ? 'rounded-code' : 'rounded-xl')}
    >
      <span
        className={cn(
          'relative flex shrink-0 overflow-hidden border-b border-default',
          recent ? 'h-30 bg-sidebar px-3.5 pt-3.5' : cn('aspect-video px-8 pt-6', look.tint),
        )}
      >
        <span
          className={cn(
            PAGE,
            kind === 'canvas' ? 'bg-subtle' : 'bg-canvas',
            recent ? 'rounded-t-md' : 'rounded-t-lg',
          )}
        >
          <PageContent thumbnail={thumbnail} faded={artifact.deletedAt !== null} />
        </span>
        {artifact.editing.length > 0 && <EditingPill />}
      </span>
      <span
        className={cn(
          'flex min-w-0 items-center gap-2.5',
          recent ? 'px-3 pt-2.25 pb-2.75' : 'h-16 pr-11 pl-3',
        )}
      >
        {!recent && (
          <span
            role="img"
            aria-label={t(`page.kinds.${kind}`)}
            className={cn('grid size-8 shrink-0 place-items-center rounded-lg', look.tint)}
          >
            <look.icon className={cn('size-4', look.color)} />
          </span>
        )}
        <span className={cn('flex min-w-0 flex-col', recent ? 'gap-px pr-6' : 'gap-0.5')}>
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
              {lead}
              {time && <Ago time={time} />}
            </span>
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
            <VersionTime artifact={artifact} />
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
              size={recent ? 'icon-xs' : 'icon-sm'}
              tabIndex={-1}
              aria-label={t('card.more', { title: artifact.title })}
              className={cn(
                'absolute opacity-0 transition-opacity duration-(--duration-fast) group-focus-within/card:opacity-100 group-hover/card:opacity-100 data-popup-open:opacity-100',
                recent ? 'right-2 bottom-3' : 'right-3 bottom-4.5',
              )}
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

/**
 * The page at the band's width and its own proportions: a page as rendered, or a canvas's pages
 * where they lie on its ground; or why neither shows.
 */
function PageContent({ thumbnail, faded }: { thumbnail: Thumbnail; faded: boolean }) {
  const { t } = useTranslation('artifacts')
  if (thumbnail.state === 'loading') return <Skeleton className="absolute inset-0 rounded-none" />
  if (thumbnail.state === 'failed') {
    return (
      <span className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-subtle text-xs text-tertiary">
        <ImageOffIcon className="size-3.5" />
        {t('card.noPreview')}
      </span>
    )
  }
  return (
    <span
      className={cn(
        'absolute inset-x-0 top-0 block aspect-16/10 animate-in fade-in duration-(--duration-fast)',
        faded && FADED,
      )}
    >
      <img src={thumbnail.src} alt="" draggable={false} className="size-full object-cover" />
      {/* The image draws the pages on a clear ground; each page takes its edge over it. */}
      {thumbnail.pages?.map((page, i) => (
        <span
          key={i}
          aria-hidden
          className="absolute shadow-[0_0_0_var(--hairline)_var(--border-default)]"
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
function Ago({ time }: { time: CardTime }) {
  const { t } = useTranslation('artifacts')
  const ago = longAgo(time.at, useNow())
  return <> · {time.opened ? t('card.opened', { time: ago }) : ago}</>
}

/** In the tooltip only, so it reads the time as it opens. */
function VersionTime({ artifact }: { artifact: ArtifactSummary }) {
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
  const recent = variant === 'recent'
  return (
    <div
      aria-hidden
      className={cn(
        'flex min-w-0 flex-col overflow-hidden border border-default',
        recent ? 'rounded-code' : 'rounded-xl',
      )}
    >
      <Skeleton className={cn('w-full rounded-none', recent ? 'h-30' : 'aspect-video')} />
      <div
        className={cn('flex items-center gap-2.5', recent ? 'px-3 pt-2.25 pb-2.75' : 'h-16 px-3')}
      >
        {!recent && <Skeleton className="size-8 shrink-0 rounded-lg" />}
        <div className="flex min-w-0 flex-1 flex-col">
          <Skeleton className="mt-0.5 h-3 w-[62%]" />
          <Skeleton className="mt-1.5 h-2.5 w-[40%]" />
        </div>
      </div>
    </div>
  )
}
