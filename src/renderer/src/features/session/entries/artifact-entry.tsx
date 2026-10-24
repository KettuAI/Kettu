import { memo, useEffect, useId, useRef, useState } from 'react'
import { ImageOffIcon, ShapesIcon, TrashIcon } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import type { ArtifactEntry as Entry } from '@shared/thread'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { cn } from '@renderer/lib/utils'
import { useInView } from '@renderer/features/artifacts/use-in-view'
import { useThumbnail, type Thumbnail } from '@renderer/features/artifacts/thumbnails'
import { artifactListShown, useArtifactsStore } from '@renderer/stores/artifacts'
import { toggleArtifactPane, useViewStore } from '@renderer/stores/view'
import { useEntry, useEntryAnimation } from '../use-thread'

/**
 * A write to the artifacts service: a card that opens the artifact beside the thread, or a line
 * for a deletion.
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
  if (!entry) return null
  if (entry.action === 'delete') return <DeletedLine entry={entry} className={animation} />
  return <ArtifactCard entry={entry} projectPath={projectPath} className={animation} />
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

function ArtifactCard({
  entry,
  projectPath,
  className,
}: {
  entry: Entry
  projectPath: string
  className: string | undefined
}) {
  const { t } = useTranslation('session')
  const card = useRef<HTMLButtonElement>(null)
  const captionId = useId()
  const standing = useStanding(entry.artifactId)
  const pages = useArtifactsStore(
    (s) =>
      (
        s.list?.find((a) => a.id === entry.artifactId) ??
        s.deleted?.find((a) => a.id === entry.artifactId)
      )?.pages ?? null,
  )
  const pressed = useViewStore(
    (s) =>
      s.sidePane[projectPath] === 'artifact' && s.sideArtifact[projectPath] === entry.artifactId,
  )
  const inView = useInView(card)
  const thumbnail = useThumbnail(
    { id: entry.artifactId, version: entry.version ?? 0, pages: pages ?? 0 },
    inView && pages !== null && entry.version !== null,
  )
  // A later write keeps the earlier picture under the new one until the new one is made.
  const [shown, setShown] = useState<Thumbnail | null>(null)
  if (thumbnail.state === 'ready' && shown !== thumbnail) setShown(thumbnail)
  const caption = [
    entry.version === null
      ? t(`artifactEntry.${entry.action}`)
      : `${t(`artifactEntry.${entry.action}`)} · ${t('artifactEntry.version', { version: entry.version })}`,
    entry.writes > 1 && t('artifactEntry.writes', { count: entry.writes }),
    standing === 'deleted' && t('artifactEntry.deleted'),
    standing === 'erased' && t('artifactEntry.erased'),
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <button
      ref={card}
      type="button"
      disabled={standing === 'erased'}
      aria-pressed={pressed}
      aria-label={t('artifactEntry.open', { title: entry.title })}
      aria-describedby={captionId}
      onClick={() => toggleArtifactPane(projectPath, entry.artifactId)}
      className={cn(
        'group/artifact flex min-h-14 w-full max-w-[480px] items-center gap-3 rounded-xl bg-surface py-2 pr-2.5 pl-2 text-left shadow-card outline-none transition-[background-color,box-shadow] duration-(--duration-fast) focus-ring enabled:hover:bg-hover enabled:hover:shadow-[inset_0_0_0_var(--hairline)_var(--border-strong)] aria-pressed:bg-pressed enabled:aria-pressed:hover:bg-pressed-hover',
        className,
      )}
    >
      <span
        className={cn(
          'relative h-10 w-16 shrink-0 overflow-hidden rounded-md bg-subtle',
          standing !== 'live' && 'opacity-50 grayscale',
        )}
      >
        {standing === 'erased' ? (
          <Preview thumbnail={{ state: 'failed' }} />
        ) : (
          <Preview thumbnail={thumbnail.state === 'loading' && shown ? shown : thumbnail} />
        )}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-[inherit] shadow-[inset_0_0_0_var(--hairline)_var(--border-default)]"
        />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-ui font-medium text-primary">{entry.title}</span>
        <span id={captionId} className="truncate text-xs text-tertiary tabular-nums">
          {caption}
        </span>
      </span>
      {standing !== 'erased' && (
        <span
          aria-hidden
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-control text-primary shadow-[inset_0_0_0_var(--hairline)_var(--border-strong)] group-aria-pressed/artifact:bg-app group-aria-pressed/artifact:shadow-none"
        >
          <ShapesIcon className="size-3.5" />
          {t('artifactEntry.openShort')}
        </span>
      )}
    </button>
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
      className="absolute inset-0 size-full animate-in object-cover duration-(--duration-fast) fade-in"
    />
  )
}
