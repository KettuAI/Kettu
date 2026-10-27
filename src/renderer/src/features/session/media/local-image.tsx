import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MediaGrant } from '@shared/media'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { cn } from '@renderer/lib/utils'
import { imageSurface } from './surface'

/** The tallest an image shows in a reply; the viewer shows it whole. */
const MAX_HEIGHT = 288

/** An image a reply names, in place, as a button that opens the viewer. */
export function LocalImage({
  name,
  alt,
  grant,
  viewerKey,
  maxHeight = MAX_HEIGHT,
  onOpen,
  onFailed,
}: {
  name: string
  alt: string
  grant: MediaGrant
  viewerKey: string
  maxHeight?: number
  onOpen: (from: HTMLElement) => void
  onFailed: () => void
}) {
  const { t } = useTranslation('session')
  const [loaded, setLoaded] = useState(false)
  const surface = imageSurface({ path: name, mimeType: grant.mimeType })
  const box =
    grant.width && grant.height
      ? {
          width: `min(100%, ${grant.width}px, ${(maxHeight * grant.width) / grant.height}px)`,
          aspectRatio: `${grant.width} / ${grant.height}`,
        }
      : undefined
  return (
    <button
      type="button"
      aria-label={t('media.openImage', { name: alt || name })}
      data-viewer-key={viewerKey}
      onClick={(event) => onOpen(event.currentTarget)}
      style={box}
      className={cn(
        'group/media relative mr-1.5 inline-block max-w-full cursor-zoom-in overflow-hidden rounded-xl bg-card align-top focus-ring',
        !box && !loaded && 'size-24',
      )}
    >
      {!loaded && (
        // Shown only when the picture takes a while, so a quick one never flashes.
        <span className="absolute inset-0 animate-in fade-in fill-mode-both delay-200 duration-(--duration-fast)">
          <Skeleton render={<span />} className="block size-full rounded-[inherit]" />
        </span>
      )}
      <img
        src={grant.url}
        alt={alt}
        decoding="async"
        loading="lazy"
        onLoad={() => setLoaded(true)}
        onError={onFailed}
        style={box ? undefined : { maxHeight }}
        className={cn(
          'block',
          surface === 'canvas' ? 'bg-canvas' : 'bg-card checkerboard',
          box ? 'size-full object-contain' : 'max-w-full',
        )}
      />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-[inherit] shadow-[inset_0_0_0_var(--hairline)_var(--border-default)] transition-shadow duration-(--duration-fast) group-hover/media:shadow-[inset_0_0_0_var(--hairline)_var(--border-strong)]"
      />
    </button>
  )
}
