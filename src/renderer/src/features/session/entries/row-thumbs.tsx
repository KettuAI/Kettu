import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { cn } from '@renderer/lib/utils'
import { CarriedImage } from '../media/carried-image'
import { FRAME, FrameRing } from '../media/frame'
import { EntryIdContext, SessionIdContext } from '../media/grants'
import { imageSurface } from '../media/surface'
import { useMediaFile } from '../media/use-media-file'
import type { RowPicture } from './row-pictures'

/** How many thumbnails a row shows; the rest are counted. */
const MAX_THUMBS = 3

const THUMB = 'h-6.5 w-9.5 shrink-0'
const NO_PICTURES: ReadonlySet<string> = new Set()

/** The pictures a row shows: the last few of those that can be shown, and how many are left out. */
function useRowThumbs(pictures: readonly RowPicture[]) {
  // A named file that turns out not to be an image, or not to exist, leaves no thumbnail.
  const [gone, setGone] = useState(NO_PICTURES)
  const markGone = useCallback(
    (key: string) => setGone((now) => (now.has(key) ? now : new Set(now).add(key))),
    [],
  )
  const usable = pictures.filter((picture) => !gone.has(picture.key))
  const shown = usable.slice(-MAX_THUMBS)
  return { shown, more: usable.length - shown.length, markGone }
}

/**
 * A fold row's frame: its trigger, then thumbnails of the pictures its steps carry or name, at the
 * row's end and outside the trigger, since a button cannot hold buttons. A click on a thumbnail
 * opens the viewer and leaves the row as it is. While the row is open its details show the
 * pictures, so the thumbnails give way, and the row keeps its height. `className` is the row's
 * frame without them, `filled` what it adds once it has some.
 */
export function ThumbRow({
  sessionId,
  pictures,
  open,
  className,
  filled,
  children,
}: {
  sessionId: string
  pictures: readonly RowPicture[]
  open: boolean
  className?: string
  filled?: string
  children: ReactNode
}) {
  const { shown, more, markGone } = useRowThumbs(pictures)
  const has = shown.length > 0
  return (
    <div
      className={cn(
        'flex rounded-tile transition-colors duration-(--duration-fast) hover:bg-hover',
        className,
        has && cn('min-h-9', filled),
      )}
    >
      {children}
      {has && !open && (
        <RowThumbs sessionId={sessionId} shown={shown} more={more} onGone={markGone} />
      )}
    </div>
  )
}

function RowThumbs({
  sessionId,
  shown,
  more,
  onGone,
}: {
  sessionId: string
  shown: RowPicture[]
  more: number
  onGone: (key: string) => void
}) {
  const { t } = useTranslation('session')
  return (
    <span className="mr-1.5 flex shrink-0 items-center gap-1">
      {shown.map((picture) =>
        picture.kind === 'ref' ? (
          <CarriedImage
            key={picture.key}
            sessionId={sessionId}
            entryId={picture.entryId}
            index={picture.index}
            mimeType={picture.mimeType}
            data={picture.data}
            className={cn(THUMB, 'object-cover')}
          />
        ) : (
          <SessionIdContext key={picture.key} value={sessionId}>
            <EntryIdContext value={picture.entryId}>
              <FileThumb picture={picture} onGone={onGone} />
            </EntryIdContext>
          </SessionIdContext>
        ),
      )}
      {more > 0 && (
        <span aria-hidden className="ml-0.5 text-count text-tertiary tabular">
          {t('media.moreBadge', { count: more })}
        </span>
      )}
    </span>
  )
}

/** A named picture file, cropped to a thumbnail, asking for its grant once it nears the view. */
function FileThumb({
  picture,
  onGone,
}: {
  picture: Extract<RowPicture, { kind: 'file' }>
  onGone: (key: string) => void
}) {
  const { t } = useTranslation('session')
  const near = useRef<HTMLSpanElement>(null)
  const media = useMediaFile(picture.path, false, near)
  const { shown, name } = media
  const asking = shown.kind === 'asking' && media.enabled
  const image = shown.kind === 'granted' && !shown.grant.tooLarge && shown.grant.kind === 'image'
  const gone = !asking && !image

  useEffect(() => {
    if (gone) onGone(picture.key)
  }, [gone, onGone, picture.key])

  if (gone) return null
  if (shown.kind !== 'granted') {
    return (
      <span ref={near} className={cn(FRAME, 'block', THUMB)}>
        {/* Shown only when the file takes a while, so a quick one never flashes. */}
        <span className="block size-full animate-in fade-in fill-mode-both delay-200 duration-(--duration-fast)">
          <Skeleton render={<span />} className="block size-full rounded-none" />
        </span>
      </span>
    )
  }
  const { grant } = shown
  const surface = imageSurface({ path: name, mimeType: grant.mimeType })
  return (
    <button
      type="button"
      aria-label={t('media.openImage', { name })}
      data-viewer-key={media.viewerKey}
      onClick={(event) => media.open(event.currentTarget)}
      className={cn(FRAME, 'group/media block cursor-zoom-in focus-ring', THUMB)}
    >
      <img
        src={grant.url}
        alt=""
        decoding="async"
        loading="lazy"
        onError={() => media.failed(grant, null)}
        className={cn(
          'block size-full object-cover',
          surface === 'canvas' ? 'bg-canvas' : 'checkerboard',
        )}
      />
      <FrameRing />
    </button>
  )
}
