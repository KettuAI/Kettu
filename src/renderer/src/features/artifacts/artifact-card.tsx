import { memo, useRef, useState } from 'react'
import { EllipsisIcon, GlobeIcon, ImageOffIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ArtifactSummary } from '@shared/artifacts'
import type { AgentId } from '@shared/thread'
import { AgentMark } from '@renderer/components/agents/agent-mark'
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
import { artifactKind } from './model'
import { useThumbnail, type Thumbnail } from './thumbnails'
import { useInView } from './use-in-view'

/** Opens the viewer; Back returns to the page with this card focused. */
function openFromPage(id: string, history = false): void {
  useArtifactsStore.setState({ opened: id })
  openArtifact(id, { history })
}

// The preview's edge is drawn over the image; pointed at, focused or held, it darkens.
const FRAME =
  'relative block aspect-16/10 overflow-hidden rounded-2xl after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:shadow-[inset_0_0_0_1px_var(--border-subtle)] after:transition-shadow after:duration-(--duration-fast) group-hover/open:after:shadow-[inset_0_0_0_1px_var(--border-strong)] group-focus-visible/open:outline-2 group-focus-visible/open:outline-offset-2 group-focus-visible/open:outline-focus group-data-held/card:after:shadow-[inset_0_0_0_1px_var(--border-strong)]'
// What lies in Recently deleted shows faded.
const FADED = 'opacity-72 grayscale-85'

/** The time the card shows: when it was opened on this device, or its latest version. */
export interface CardTime {
  at: number
}

/**
 * One artifact: its preview, then its title and a line of the agent's mark, its kind and when it
 * was last seen, with its menu over the preview's corner.
 */
export const ArtifactCard = memo(function ArtifactCard({
  artifact,
  agent,
  meta,
  time,
  project,
  session,
  tabbable,
}: {
  artifact: ArtifactSummary
  /** The agent of the session it shows under; none when imported or that session is gone. */
  agent: AgentId | null
  /** The line after the mark: its kind and pages, the version when grouped; in Recently deleted,
   * the days left. */
  meta: string
  time: CardTime | null
  project: string
  session: string
  tabbable: boolean
}) {
  const { t } = useTranslation('artifacts')
  const card = useRef<HTMLDivElement>(null)
  const thumbnail = useThumbnail(artifact, useInView(card))
  const [moreOpen, setMoreOpen] = useState(false)
  const [contextOpen, setContextOpen] = useState(false)
  const shared = useSharingStore(
    (s) => s.status?.published.some((page) => page.id === artifact.id) ?? false,
  )
  const kind = artifactKind(artifact)

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
      onOpen={() => openFromPage(artifact.id)}
      onVersionHistory={() => openFromPage(artifact.id, true)}
    />
  )

  const button = (
    <button
      type="button"
      data-artifact-card={artifact.id}
      tabIndex={tabbable ? 0 : -1}
      onClick={() => openFromPage(artifact.id)}
      onKeyDown={(event) => {
        // The context menu key opens the More menu, the card's menu for the keyboard.
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault()
          setMoreOpen(true)
        }
      }}
      className="group/open flex w-full flex-col gap-2.5 text-left outline-none"
    >
      {/* A canvas's pages lie on a light desk in either theme, as their content is light. */}
      <span
        className={cn(
          FRAME,
          kind === 'canvas'
            ? 'bg-[color-mix(in_oklab,var(--canvas-ink)_5%,var(--canvas))]'
            : 'bg-canvas',
        )}
      >
        <PageContent thumbnail={thumbnail} faded={artifact.deletedAt !== null} />
        {artifact.editing.length > 0 && <EditingPill />}
      </span>
      <span className="flex min-w-0 flex-col gap-1 px-0.5">
        <span className="truncate text-row leading-[normal] font-medium text-primary">
          {artifact.title}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-hint leading-[normal] text-tertiary tabular-nums">
          {agent && <AgentMark agent={agent} size={12} className="shrink-0" />}
          {shared && (
            <GlobeIcon
              role="img"
              aria-label={t('card.shared')}
              className="size-3 shrink-0 text-success"
            />
          )}
          <span className="truncate">{meta}</span>
          {time && (
            <>
              <span aria-hidden className="text-border-strong">
                ·
              </span>
              <Ago time={time} />
            </>
          )}
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
      {/* Over the preview's corner, so the caption keeps its width; the card's Tab stop is its own. */}
      <DropdownMenu open={moreOpen} onOpenChange={setMoreOpen}>
        <DropdownMenuTrigger
          render={
            <Button
              variant="outline"
              size="icon-xs"
              tabIndex={-1}
              aria-label={t('card.more', { title: artifact.title })}
              className="absolute top-2 right-2 opacity-0 transition-opacity duration-(--duration-fast) group-focus-within/card:opacity-100 group-hover/card:opacity-100 data-popup-open:opacity-100"
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
 * The page as rendered at the frame's width, or a canvas's pages where they lie on its ground; or
 * why neither shows.
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
        'absolute inset-0 block animate-in fade-in duration-(--duration-fast)',
        faded && FADED,
      )}
    >
      <img src={thumbnail.src} alt="" draggable={false} className="size-full object-cover" />
      {/* The image draws the pages on a clear ground; each page takes its edge over it. */}
      {thumbnail.pages?.map((page, i) => (
        <span
          key={i}
          aria-hidden
          className="absolute shadow-[0_0_0_var(--hairline)_color-mix(in_oklab,var(--canvas-ink)_8%,transparent)]"
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
  return <span className="shrink-0">{longAgo(time.at, useNow())}</span>
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
export function CardSkeleton() {
  return (
    <div aria-hidden className="flex min-w-0 flex-col gap-2.5">
      <Skeleton className="aspect-16/10 w-full rounded-2xl" />
      <div className="flex flex-col gap-1.5 px-0.5">
        <Skeleton className="mt-0.5 h-3.5 w-[62%]" />
        <Skeleton className="h-3 w-[40%]" />
      </div>
    </div>
  )
}
