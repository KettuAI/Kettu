import { useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@renderer/lib/utils'
import { VIDEO_BOX } from './boxes'
import { playedUrl, type PlayedMedia } from './carried'
import { playerFailure } from './failure'
import { MediaCaption } from './media-caption'
import { playOneAtATime } from './playback'

/** The tallest a clip shows in the thread; the viewer shows it larger. */
const MAX_HEIGHT = 480

/**
 * A clip a reply names or the thread carries, with Chromium's controls, in the images' frame: the
 * column's width at its own ratio, at most 480 px high. Open larger opens the viewer, which takes
 * over the player's moment; without `onOpen` there is none. `onFailed` hears an error or a clip
 * with no picture.
 */
export function LocalVideo({
  media,
  name,
  viewerKey,
  onOpen,
  onFailed,
}: {
  media: PlayedMedia
  name: string
  viewerKey?: string
  onOpen?: (from: HTMLElement) => void
  onFailed: (message: string | null) => void
}) {
  const frame = useRef<HTMLSpanElement>(null)
  const src = useMemo(() => playedUrl(media), [media])
  const [ratio, setRatio] = useState<{ width: number; height: number } | null>(null)
  const [seconds, setSeconds] = useState<number | null>(null)
  useEffect(playOneAtATime, [])

  const box = ratio
    ? {
        width: `min(100%, ${(MAX_HEIGHT * ratio.width) / ratio.height}px)`,
        aspectRatio: `${ratio.width} / ${ratio.height}`,
      }
    : VIDEO_BOX

  return (
    <span className="group/media block w-full">
      <span
        ref={frame}
        data-viewer-key={viewerKey}
        style={box}
        className="relative block overflow-hidden rounded-xl bg-card"
      >
        <video
          src={src}
          controls
          controlsList="nodownload"
          preload="metadata"
          aria-label={name}
          onLoadedMetadata={(event) => {
            const { videoWidth, videoHeight, duration } = event.currentTarget
            // Chromium loads some formats, such as ProRes, with sound and a picture of 0 x 0.
            if (videoWidth === 0 || videoHeight === 0) {
              onFailed(null)
              return
            }
            setRatio({ width: videoWidth, height: videoHeight })
            setSeconds(duration)
          }}
          onError={(event) => onFailed(playerFailure(event.currentTarget))}
          className="block size-full object-contain"
        />
        <span
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-0 rounded-[inherit] transition-shadow duration-(--duration-fast)',
            'shadow-[inset_0_0_0_var(--hairline)_var(--border-default)] group-hover/media:shadow-[inset_0_0_0_var(--hairline)_var(--border-strong)]',
          )}
        />
      </span>
      <MediaCaption
        media={media}
        name={name}
        seconds={seconds}
        onOpenLarger={onOpen && (() => frame.current && onOpen(frame.current))}
      />
    </span>
  )
}
