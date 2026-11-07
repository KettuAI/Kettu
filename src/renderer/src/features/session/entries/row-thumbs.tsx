import { useCallback, useEffect, useRef, useState } from 'react'
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
 * Thumbnails of the pictures a folded row's steps carry or name, at the row's end and outside its
 * toggle, since a button cannot hold buttons. A click on one opens the viewer and leaves the row as
 * it is; an open row shows the pictures in its details instead (styles/session.css).
 */
export function RowThumbs({
  sessionId,
  pictures,
}: {
  sessionId: string
  pictures: readonly RowPicture[]
}) {
  const { shown, more, markGone } = useRowThumbs(pictures)
  if (shown.length === 0) return null
  return <ThumbList sessionId={sessionId} shown={shown} more={more} onGone={markGone} />
}

function ThumbList({
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
    <span className="ks-thumbs flex shrink-0 items-center gap-1">
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
  const [loaded, setLoaded] = useState(false)
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
        onLoad={() => setLoaded(true)}
        onError={() => media.failed(grant, null)}
        className={cn(
          'block size-full object-cover transition-opacity duration-(--duration-fast)',
          surface === 'canvas' ? 'bg-canvas' : 'checkerboard',
          !loaded && 'opacity-0',
        )}
      />
      <FrameRing />
    </button>
  )
}
