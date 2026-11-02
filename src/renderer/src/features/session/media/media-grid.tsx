import { useContext, useEffect, useRef, useState } from 'react'
import { CircleAlertIcon, ImageOffIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { cn } from '@renderer/lib/utils'
import { FrameRing } from './frame'
import { gridTiles } from './layout'
import { NamedMediaContext } from './named'
import { imageSurface } from './surface'
import { useMediaFile } from './use-media-file'

const TILE = 'relative h-24 min-w-0 overflow-hidden rounded-tile'

/**
 * Two or more pictures one block names, as a row of three tiles; past three, the last tile counts
 * the rest. The viewer still steps through all of them. `images` marks them as Markdown images,
 * which the blocks of their message then leave out.
 */
export function MediaGrid({
  paths,
  images = false,
}: {
  paths: readonly string[]
  images?: boolean
}) {
  const { tiles, more } = gridTiles(paths)
  const named = useContext(NamedMediaContext)
  const rest = paths.slice(tiles.length).join('\0')
  // No tile stands for the pictures the last one counts, so the grid marks them itself.
  useEffect(() => {
    if (!images || !named || rest === '') return
    const marks = rest.split('\0').map((path) => named.image(path))
    return () => marks.forEach((unmark) => unmark())
  }, [images, named, rest])
  return (
    <div className="grid w-full max-w-[600px] grid-cols-3 gap-1.5">
      {tiles.map((path, i) => (
        <LocalTile key={path} path={path} image={images} more={i === tiles.length - 1 ? more : 0} />
      ))}
    </div>
  )
}

/** One picture of a grid, cropped to its tile, as a button that opens the viewer. */
function LocalTile({ path, image, more }: { path: string; image: boolean; more: number }) {
  const { t } = useTranslation('session')
  const near = useRef<HTMLSpanElement>(null)
  const media = useMediaFile(path, image, near)
  const { shown, name } = media
  const [loaded, setLoaded] = useState(false)

  // Without a session nothing can be read, so the picture stays its name, as LocalMedia's does.
  if (!media.enabled) {
    return (
      <span title={path} className="min-w-0 truncate">
        {name}
        {more > 0 && ` ${t('media.moreBadge', { count: more })}`}
      </span>
    )
  }
  if (shown.kind === 'asking') {
    return (
      <span ref={near} className={cn(TILE, 'block')}>
        <Skeleton render={<span />} className="block size-full rounded-[inherit]" />
      </span>
    )
  }
  if (shown.kind === 'granted' && !shown.grant.tooLarge && shown.grant.kind === 'image') {
    const { grant } = shown
    const surface = imageSurface({ path: name, mimeType: grant.mimeType })
    return (
      <button
        type="button"
        aria-label={
          more > 0
            ? t('media.openImageMore', { name, count: more })
            : t('media.openImage', { name })
        }
        data-viewer-key={media.viewerKey}
        onClick={(event) => media.open(event.currentTarget)}
        className={cn(TILE, 'group/media block cursor-zoom-in bg-card focus-ring')}
      >
        {!loaded && (
          <span className="absolute inset-0 animate-in fade-in fill-mode-both delay-200 duration-(--duration-fast)">
            <Skeleton render={<span />} className="block size-full rounded-none" />
          </span>
        )}
        <img
          src={grant.url}
          alt=""
          decoding="async"
          loading="lazy"
          onLoad={() => setLoaded(true)}
          onError={() => media.failed(grant, null)}
          className={cn(
            'block size-full object-cover',
            surface === 'canvas' ? 'bg-canvas' : 'checkerboard',
          )}
        />
        {more > 0 && (
          <span
            aria-hidden
            className="absolute right-1.5 bottom-1.5 flex h-5 items-center rounded-md bg-(--media-badge) px-1.5 text-badge text-(color:--media-foreground) tabular"
          >
            {t('media.moreBadge', { count: more })}
          </span>
        )}
        <FrameRing />
      </button>
    )
  }

  // A tile whose picture cannot show keeps its place and says why on hover; one that is missing
  // or unreadable asks again when pressed.
  const failed = shown.kind === 'failed'
  const why =
    shown.kind === 'failed'
      ? t('media.cannotReadShort', { message: shown.message })
      : shown.kind === 'missing'
        ? t('media.notFound', { path })
        : shown.kind === 'granted' && shown.grant.tooLarge
          ? t('media.tooLargeShort')
          : shown.kind === 'text'
            ? path
            : t('media.unsupportedShort')
  const body = (
    <>
      {failed ? (
        <CircleAlertIcon className="size-4 text-danger" />
      ) : (
        <ImageOffIcon className="size-4 text-icon" />
      )}
      <span className="w-full truncate text-meta text-tertiary">{name}</span>
      <FrameRing />
    </>
  )
  const state = cn(TILE, 'flex flex-col items-center justify-center gap-1 bg-subtle px-2')
  if (shown.kind === 'missing' || shown.kind === 'failed') {
    return (
      <button
        type="button"
        title={why}
        aria-label={t('media.retryFile', { name })}
        onClick={media.retry}
        className={cn(state, 'group/media focus-ring')}
      >
        {body}
      </button>
    )
  }
  return (
    <span title={why} className={state}>
      {body}
    </span>
  )
}
