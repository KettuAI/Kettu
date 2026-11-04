import { memo, useEffect, useId, useRef, useState } from 'react'
import { EllipsisIcon, ExternalLinkIcon, ImageOffIcon, ShapesIcon, TrashIcon } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import type { ArtifactSummary, VersionSummary } from '@shared/artifacts'
import type { ArtifactEntry as Entry } from '@shared/thread'
import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Spinner } from '@renderer/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { ArtifactMenuItems } from '@renderer/features/artifacts/artifact-menu'
import { KIND_LOOK } from '@renderer/features/artifacts/kinds'
import { artifactKind } from '@renderer/features/artifacts/model'
import { ShareButton } from '@renderer/features/artifacts/share-popover'
import { useThumbnail, type Thumbnail } from '@renderer/features/artifacts/thumbnails'
import { useInView } from '@renderer/features/artifacts/use-in-view'
import { longAgo } from '@renderer/lib/format'
import { errorMessage, host } from '@renderer/lib/host'
import { useHostHas } from '@renderer/lib/host-features'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { artifactListShown, useArtifactsStore } from '@renderer/stores/artifacts'
import { useSharingStore } from '@renderer/stores/sharing'
import { useThreadsStore } from '@renderer/stores/threads'
import { openArtifact, toggleArtifactPane, useViewStore } from '@renderer/stores/view'
import { useEntry, useEntryAnimation } from '../use-thread'
import { artifactCardSize, isLastArtifactEntry, type ArtifactCardSize } from './artifact-size'

/**
 * A write to the artifacts service: a card that opens the artifact beside the thread, large for a
 * turn's main output and compact otherwise, or a line for a deletion.
 */
export const ArtifactEntry = memo(function ArtifactEntry({
  sessionId,
  entryId,
  projectPath,
}: {
  sessionId: string
  entryId: string
  projectPath: string
}) {
  const entry = useEntry(sessionId, entryId, 'artifact')
  const animation = useEntryAnimation(sessionId, entryId)
  const size = useThreadsStore((s) => {
    const state = s.replicas[sessionId]?.state
    return state ? artifactCardSize(state, entryId) : 'compact'
  })
  const last = useThreadsStore((s) => {
    const state = s.replicas[sessionId]?.state
    return state ? isLastArtifactEntry(state, entryId) : false
  })
  if (!entry) return null
  if (entry.action === 'delete') return <DeletedLine entry={entry} className={animation} />
  return (
    <ArtifactCard
      entry={entry}
      sessionId={sessionId}
      projectPath={projectPath}
      size={size}
      last={last}
      className={animation}
    />
  )
})

function DeletedLine({ entry, className }: { entry: Entry; className: string | undefined }) {
  const { t } = useTranslation('session')
  return (
    <div className={cn('flex min-h-6 items-center gap-2 text-small text-tertiary', className)}>
      <TrashIcon className="size-3.5 shrink-0 text-icon" />
      <span className="min-w-0 truncate">
        <Trans
          t={t}
          i18nKey="artifactEntry.deletedLine"
          components={{ title: <span className="text-primary">{entry.title}</span> }}
        />
      </span>
    </div>
  )
}

/** Where the artifact stands now: the card dims once it is deleted. */
type Standing = 'live' | 'deleted' | 'erased'

function useStanding(id: string): Standing {
  useEffect(() => {
    artifactListShown(true)
    return () => artifactListShown(false)
  }, [])
  return useArtifactsStore((s) => {
    if (s.list?.some((a) => a.id === id)) return 'live'
    if (s.deleted?.some((a) => a.id === id)) return 'deleted'
    // Until both lists arrive, nothing says it is gone.
    return s.list && s.deleted ? 'erased' : 'live'
  })
}

/** Each artifact's latest read of its versions, at the head it was read for, shared by its cards. */
const versionReads = new Map<
  string,
  { head: number | null; versions: VersionSummary[] | null; done: Promise<void> }
>()

/**
 * The version an entry wrote, read once its card is in view. A version never changes once
 * written, so a card that has its own asks nothing more, and the artifact's cards share each read.
 */
function useEntryVersion(
  id: string,
  version: number | null,
  head: number | null,
  inView: boolean,
): VersionSummary | null {
  const [, setDone] = useState(0)
  const found =
    version === null
      ? null
      : (versionReads.get(id)?.versions?.find((v) => v.version === version) ?? null)
  const missing = version !== null && found === null
  useEffect(() => {
    if (!inView || !missing) return
    let read = versionReads.get(id)
    if (!read || read.head !== head) {
      const next = { head, versions: null as VersionSummary[] | null, done: Promise.resolve() }
      // A failed read leaves the card without its time and note until the head moves.
      next.done = host('artifacts.versions', { id }).then(
        (versions) => void (next.versions = versions),
        () => undefined,
      )
      versionReads.set(id, next)
      read = next
    }
    let live = true
    void read.done.then(() => live && setDone((n) => n + 1))
    return () => {
      live = false
    }
  }, [id, head, inView, missing])
  return found
}

const AGO = {
  create: 'artifactEntry.createdAgo',
  update: 'artifactEntry.updatedAgo',
  restore: 'artifactEntry.restoredAgo',
} as const

/** What both sizes of card show, read from the entry, the lists, the versions and sharing. */
interface CardView {
  entry: Entry
  summary: ArtifactSummary | null
  standing: Standing
  /** The agent's running turn is still writing it. */
  writing: boolean
  pressed: boolean
  thumbnail: Thumbnail
  meta: string
  chips: string[]
  metaId: string
  open: () => void
}

function ArtifactCard({
  entry,
  sessionId,
  projectPath,
  size,
  last,
  className,
}: {
  entry: Entry
  sessionId: string
  projectPath: string
  size: ArtifactCardSize
  last: boolean
  className: string | undefined
}) {
  const { t } = useTranslation(['session', 'artifacts'])
  const card = useRef<HTMLDivElement>(null)
  const metaId = useId()
  const standing = useStanding(entry.artifactId)
  const summary = useArtifactsStore(
    (s) =>
      s.list?.find((a) => a.id === entry.artifactId) ??
      s.deleted?.find((a) => a.id === entry.artifactId) ??
      null,
  )
  const pressed = useViewStore(
    (s) =>
      s.sidePane[projectPath] === 'artifact' && s.sideArtifact[projectPath] === entry.artifactId,
  )
  const shares = useHostHas('sharing') === true
  const published = useSharingStore((s) =>
    s.status ? s.status.published.some((page) => page.id === entry.artifactId) : null,
  )
  const now = useNow()
  const inView = useInView(card)
  const version = useEntryVersion(entry.artifactId, entry.version, summary?.version ?? null, inView)
  const made = useThumbnail(
    { id: entry.artifactId, version: entry.version ?? 0, pages: summary?.pages ?? 0 },
    inView && summary !== null && entry.version !== null,
  )
  // A later write keeps the earlier picture under the new one until the new one is made.
  const [kept, setKept] = useState<Thumbnail | null>(null)
  if (made.state === 'ready' && kept !== made) setKept(made)
  const thumbnail: Thumbnail =
    standing === 'erased' ? { state: 'failed' } : made.state === 'loading' && kept ? kept : made

  const writing = last && standing === 'live' && !!summary?.editing.includes(sessionId)
  const kind = summary ? artifactKind(summary) : null
  const updatedAt =
    version?.createdAt ?? (summary && summary.version === entry.version ? summary.updatedAt : null)
  const action = entry.action === 'create' && entry.writes > 1 ? 'update' : entry.action
  const parts = [
    kind && t(`artifacts:page.kinds.${kind}`),
    !(writing && size === 'compact') &&
      entry.version !== null &&
      t('artifactEntry.version', { version: entry.version }),
    writing && t('artifactEntry.writing'),
    !writing &&
      updatedAt !== null &&
      action !== 'delete' &&
      t(AGO[action], { time: longAgo(updatedAt, now) }),
    standing === 'deleted' && t('artifactEntry.deleted'),
    standing === 'erased' && t('artifactEntry.erased'),
  ]
  const chips = [
    version?.note,
    entry.writes > 1 && t('artifactEntry.writes', { count: entry.writes }),
    shares &&
      standing === 'live' &&
      published !== null &&
      (published ? t('artifactEntry.published') : t('artifactEntry.private')),
  ].filter((chip): chip is string => !!chip)

  const view: CardView = {
    entry,
    summary,
    standing,
    writing,
    pressed,
    thumbnail,
    meta: parts.filter(Boolean).join(' · '),
    chips,
    metaId,
    open: () => toggleArtifactPane(projectPath, entry.artifactId),
  }
  return (
    <div ref={card} className={cn('w-full', className)}>
      {size === 'large' ? (
        <LargeCard view={view} shares={shares} sessionId={sessionId} projectPath={projectPath} />
      ) : (
        <CompactCard view={view} />
      )}
    </div>
  )
}

/** A card for later updates, artifacts written in passing and turns that wrote several. */
function CompactCard({ view }: { view: CardView }) {
  const { t } = useTranslation('session')
  const { entry, standing, writing } = view
  const erased = standing === 'erased'
  return (
    <button
      type="button"
      disabled={erased}
      aria-pressed={view.pressed}
      aria-label={t('artifactEntry.open', { title: entry.title })}
      aria-describedby={view.metaId}
      onClick={view.open}
      className="group/artifact flex w-full items-center gap-3.5 rounded-code bg-surface py-2.5 pr-3 pl-2.5 text-left shadow-card outline-none transition-[background-color,box-shadow] duration-(--duration-fast) focus-ring enabled:hover:bg-hover aria-pressed:bg-pressed enabled:aria-pressed:hover:bg-pressed-hover"
    >
      {writing ? (
        <span className="grid h-18 w-28 shrink-0 place-items-center rounded-tile bg-subtle">
          <Spinner className="size-4 text-tertiary" />
        </span>
      ) : (
        <span
          className={cn(
            'relative h-18 w-28 shrink-0 overflow-hidden rounded-tile bg-subtle',
            standing !== 'live' && 'opacity-50 grayscale',
          )}
        >
          <Preview thumbnail={view.thumbnail} />
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-[inherit] shadow-[inset_0_0_0_var(--hairline)_var(--border-subtle)]"
          />
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-row font-semibold text-primary">{entry.title}</span>
        <span
          id={view.metaId}
          className={cn('truncate text-hint text-tertiary tabular-nums', writing && 'mt-1.25')}
        >
          {view.meta}
        </span>
        {writing ? (
          <Skeleton render={<span />} className="mt-1.5 block h-2 w-[70%] rounded-full bg-subtle" />
        ) : (
          view.chips.length > 0 && <Chips chips={view.chips} className="mt-1.5" />
        )}
      </span>
      {!erased && !writing && (
        <span
          aria-hidden
          className="flex h-7 shrink-0 items-center rounded-lg bg-card px-3 text-control font-medium text-primary shadow-outline group-aria-pressed/artifact:bg-pressed group-aria-pressed/artifact:shadow-sunk"
        >
          {t('artifactEntry.openShort')}
        </span>
      )}
    </button>
  )
}

/**
 * A card for a turn's main output, across the reply: its preview on top, which shows Open when
 * pointed at or focused, then its title with Open, Share and its menu, or Stop while the turn
 * writes it, and what is known of it.
 */
function LargeCard({
  view,
  shares,
  sessionId,
  projectPath,
}: {
  view: CardView
  shares: boolean
  sessionId: string
  projectPath: string
}) {
  const { t } = useTranslation(['session', 'artifacts'])
  const { entry, summary, standing, writing } = view
  const erased = standing === 'erased'
  const KindIcon = summary ? KIND_LOOK[artifactKind(summary)].icon : ShapesIcon
  const [stopping, setStopping] = useState(false)
  const [stopError, setStopError] = useState<string | null>(null)
  const stop = () => {
    setStopping(true)
    setStopError(null)
    host('sessions.cancel', { sessionId })
      .catch((e: unknown) => setStopError(errorMessage(e)))
      .finally(() => setStopping(false))
  }
  const failure = writing ? stopError : null
  return (
    <div className="w-full rounded-code bg-surface shadow-card">
      <button
        type="button"
        disabled={erased}
        aria-label={t('artifactEntry.open', { title: entry.title })}
        aria-describedby={view.metaId}
        onClick={view.open}
        className="group/preview relative block h-52.5 w-full overflow-hidden rounded-t-code border-b border-subtle bg-subtle text-left outline-none focus-ring"
      >
        <span className={cn('absolute inset-0', standing !== 'live' && 'opacity-50 grayscale')}>
          <Preview thumbnail={view.thumbnail} />
        </span>
        {writing ? (
          <span className="absolute inset-0 flex items-center justify-center bg-surface/55">
            <span className="flex h-7 items-center gap-2 rounded-full bg-surface px-2.5 text-small text-secondary shadow-menu">
              <Spinner className="size-3" />
              {t('artifactEntry.writingPill')}
            </span>
          </span>
        ) : (
          !erased && (
            <span
              aria-hidden
              className="absolute top-2.5 right-2.5 flex h-6 items-center gap-1.25 rounded-lg bg-(--media-overlay) px-2 text-caption text-(color:--media-foreground) opacity-0 transition-opacity duration-(--duration-fast) group-hover/preview:opacity-100 group-focus-visible/preview:opacity-100"
            >
              <ExternalLinkIcon className="size-2.75" strokeWidth={1.5} />
              {t('artifactEntry.openShort')}
            </span>
          )
        )}
      </button>
      <div className="px-3.5 pt-3 pb-3.5">
        <div className="flex min-w-0 items-center gap-2">
          <KindIcon className="size-3.75 shrink-0 text-tertiary" />
          <span className="min-w-0 flex-1 truncate text-row font-semibold text-primary">
            {entry.title}
          </span>
          {writing ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={stopping}
              onClick={stop}
              className="px-3 text-secondary"
            >
              {t('artifactEntry.stop')}
            </Button>
          ) : (
            !erased && (
              <Button
                variant="outline"
                size="sm"
                aria-pressed={view.pressed}
                onClick={view.open}
                className="px-3 aria-pressed:bg-pressed aria-pressed:shadow-sunk"
              >
                {t('artifactEntry.openShort')}
              </Button>
            )
          )}
          {shares && summary && standing === 'live' && !writing && (
            <ShareButton
              id={summary.id}
              title={summary.title}
              shown={summary.version}
              head={summary.version}
              iconOnly
            />
          )}
          {summary && !writing && (
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <DropdownMenuTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('artifacts:viewer.more')}
                          className="text-tertiary"
                        />
                      }
                    />
                  }
                >
                  <EllipsisIcon className="size-3.5" />
                </TooltipTrigger>
                <TooltipContent>{t('artifacts:viewer.more')}</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end" className="min-w-55">
                <ArtifactMenuItems
                  target={{
                    id: summary.id,
                    title: summary.title,
                    version: summary.version,
                    versions: summary.version,
                    sessionId: summary.sessionId,
                    deletedAt: summary.deletedAt,
                    type: summary.type,
                  }}
                  onOpen={() => toggleArtifactPane(projectPath, summary.id, true)}
                  onVersionHistory={() => openArtifact(summary.id, { history: true })}
                />
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        <div
          id={view.metaId}
          className={cn(
            'mt-0.5 truncate pl-5.75 text-hint tabular-nums',
            failure ? 'text-danger' : 'text-tertiary',
          )}
        >
          {failure ?? view.meta}
        </div>
        {view.chips.length > 0 && <Chips chips={view.chips} className="mt-2 pl-5.75" />}
      </div>
    </div>
  )
}

/** Small facts under a card's line: the version's note, its writes this turn, its sharing. */
function Chips({ chips, className }: { chips: string[]; className?: string }) {
  return (
    <span className={cn('flex min-w-0 flex-wrap gap-1.5', className)}>
      {chips.map((chip) => (
        <span
          key={chip}
          className="inline-flex h-5 max-w-full items-center rounded-md bg-subtle px-1.5 text-caption text-secondary"
        >
          <span className="truncate">{chip}</span>
        </span>
      ))}
    </span>
  )
}

function Preview({ thumbnail }: { thumbnail: Thumbnail }) {
  if (thumbnail.state === 'loading') return <Skeleton className="absolute inset-0 rounded-none" />
  if (thumbnail.state === 'failed') {
    return (
      <span className="absolute inset-0 flex items-center justify-center text-icon">
        <ImageOffIcon className="size-3.5" />
      </span>
    )
  }
  return (
    <img
      key={thumbnail.src}
      src={thumbnail.src}
      alt=""
      draggable={false}
      className="absolute inset-0 size-full animate-in object-cover object-top duration-(--duration-fast) fade-in"
    />
  )
}
