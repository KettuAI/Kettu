import { memo, useEffect, useRef, useState, type RefObject } from 'react'
import { EllipsisIcon, ImageOffIcon } from 'lucide-react'
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
import { useArtifactsStore } from '@renderer/stores/artifacts'
import { openArtifact } from '@renderer/stores/view'
import { ArtifactMenuItems } from './artifact-menu'
import { useThumbnail, type Thumbnail } from './thumbnails'

/** Opens the viewer; Back returns to the page with this card focused. */
function openFromPage(id: string, history = false): void {
  useArtifactsStore.setState({ opened: id })
  openArtifact(id, { history })
}

/** One artifact on the page: its thumbnail, title and caption, and its menu. */
export const ArtifactCard = memo(function ArtifactCard({
  artifact,
  lead,
  project,
  session,
  tabbable,
}: {
  artifact: ArtifactSummary
  /** What the grouping hides: the version, the session or the project; in Recently deleted, the
   * project and the days left. */
  lead: string
  project: string
  session: string
  tabbable: boolean
}) {
  const { t } = useTranslation('artifacts')
  const card = useRef<HTMLDivElement>(null)
  const thumbnail = useThumbnail(artifact, useInView(card))
  const [moreOpen, setMoreOpen] = useState(false)
  const caption = [lead, artifact.pages >= 2 && t('card.canvas', { count: artifact.pages })]
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
      className="relative flex w-full flex-col overflow-hidden rounded-xl bg-surface text-left outline-none focus-ring"
    >
      <span className="relative block aspect-16/10 w-full overflow-hidden bg-subtle">
        <ThumbnailImage thumbnail={thumbnail} />
        {artifact.editing.length > 0 && <EditingPill />}
      </span>
      <span className="block py-3 pr-11 pl-3 shadow-[inset_0_var(--hairline)_0_var(--border-subtle)]">
        <span className="block truncate text-ui font-medium text-primary">{artifact.title}</span>
        <span className="mt-0.5 block truncate text-xs text-tertiary">{caption}</span>
      </span>
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-[inherit] shadow-card transition-shadow duration-(--duration-fast) group-hover/card:shadow-[inset_0_0_0_var(--hairline)_var(--border-strong)] group-has-focus-visible/card:shadow-[inset_0_0_0_var(--hairline)_var(--border-strong)]"
      />
    </button>
  )

  return (
    <div ref={card} className="group/card relative min-w-0">
      <ContextMenu>
        <Tooltip>
          <TooltipTrigger render={<ContextMenuTrigger render={button} />} delay={700} />
          <TooltipContent className="flex-col items-start gap-0.5">
            <span>{t('card.where', { project, session })}</span>
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
              className="absolute right-2 bottom-4 opacity-0 transition-opacity duration-(--duration-fast) group-hover/card:opacity-100 group-has-focus-visible/card:opacity-100 data-popup-open:opacity-100"
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

function ThumbnailImage({ thumbnail }: { thumbnail: Thumbnail }) {
  const { t } = useTranslation('artifacts')
  if (thumbnail.state === 'loading') return <Skeleton className="absolute inset-0 rounded-none" />
  if (thumbnail.state === 'failed') {
    return (
      <span className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-xs text-tertiary">
        <ImageOffIcon className="size-3.5" />
        {t('card.noPreview')}
      </span>
    )
  }
  return (
    <span className="absolute inset-0 animate-in fade-in duration-(--duration-fast)">
      <img src={thumbnail.src} alt="" draggable={false} className="size-full object-cover" />
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
    <span className="absolute top-2.5 left-2.5 flex h-6 items-center gap-1.5 rounded-full bg-surface pr-2.5 pl-2 text-xs text-secondary shadow-outline">
      <Spinner className="size-3" />
      {t('card.editing')}
    </span>
  )
}

/** In the tooltip only, so it reads the time as it opens. */
function CardTime({ artifact }: { artifact: ArtifactSummary }) {
  const { t } = useTranslation('artifacts')
  const now = useNow()
  return (
    <span className="opacity-70">
      {t('card.when', { version: artifact.version, time: longAgo(artifact.updatedAt, now) })}
    </span>
  )
}

/** A card that loads with the page asks for its thumbnail once it scrolls into view. */
const watched = new Map<Element, (inView: boolean) => void>()
let observer: IntersectionObserver | null = null

function useInView(ref: RefObject<Element | null>): boolean {
  const [inView, setInView] = useState(false)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    observer ??= new IntersectionObserver((entries) => {
      for (const entry of entries) watched.get(entry.target)?.(entry.isIntersecting)
    })
    watched.set(element, setInView)
    observer.observe(element)
    return () => {
      watched.delete(element)
      observer?.unobserve(element)
    }
  }, [ref])
  return inView
}

/** A card's place before the list arrives, at its real size. */
export function CardSkeleton() {
  return (
    <div aria-hidden className="relative overflow-hidden rounded-xl bg-surface">
      <Skeleton className="aspect-16/10 w-full rounded-none" />
      <div className="flex flex-col gap-2 p-4 pl-3 shadow-[inset_0_var(--hairline)_0_var(--border-subtle)]">
        <Skeleton className="h-3 w-[58%]" />
        <Skeleton className="h-2.5 w-[36%]" />
      </div>
      <span className="pointer-events-none absolute inset-0 rounded-[inherit] shadow-card" />
    </div>
  )
}
