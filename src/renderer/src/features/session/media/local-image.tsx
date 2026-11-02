import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MediaGrant } from '@shared/media'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { cn } from '@renderer/lib/utils'
import { FRAME, FrameCaption, FrameRing, MEDIA_MAX_WIDTH } from './frame'
import { imageSurface } from './surface'

/** The tallest an image shows in a reply; the viewer shows it whole. */
const MAX_HEIGHT = 288

/**
 * An image a reply names, in place, as a frame that opens the viewer, at most 600 px wide, with its
 * name and pixel size under it.
 */
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
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null)
  const loaded = natural !== null
  const surface = imageSurface({ path: name, mimeType: grant.mimeType })
  const known = grant.width && grant.height ? { width: grant.width, height: grant.height } : null
  // An SVG's own size is in CSS pixels, not the picture's, so it gives none.
  const pixels = known ?? (surface === 'checker' ? natural : null)
  const caption = [alt || name, pixels && t('media.pixels', pixels)].filter(Boolean).join(' · ')
  return (
    <span
      style={
        known
          ? {
              width: `min(100%, ${MEDIA_MAX_WIDTH}px, ${known.width}px, ${(maxHeight * known.width) / known.height}px)`,
            }
          : undefined
      }
      className="mr-1.5 inline-flex max-w-[min(100%,600px)] flex-col align-top"
    >
      <button
        type="button"
        aria-label={t('media.openImage', { name: alt || name })}
        data-viewer-key={viewerKey}
        onClick={(event) => onOpen(event.currentTarget)}
        style={known ? { aspectRatio: `${known.width} / ${known.height}` } : undefined}
        className={cn(
          FRAME,
          'group/media block max-w-full cursor-zoom-in focus-ring',
          known ? 'w-full' : !loaded && 'size-24',
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
          onLoad={(event) => {
            const { naturalWidth: width, naturalHeight: height } = event.currentTarget
            setNatural({ width, height })
          }}
          onError={onFailed}
          style={known ? undefined : { maxHeight }}
          className={cn(
            'block',
            surface === 'canvas' ? 'bg-canvas' : 'bg-card checkerboard',
            known ? 'size-full object-contain' : 'max-w-full',
          )}
        />
        <FrameRing />
      </button>
      <FrameCaption title={alt && alt !== name ? `${alt} · ${name}` : name}>{caption}</FrameCaption>
    </span>
  )
}
