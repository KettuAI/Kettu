import { useEffect, useRef, useState } from 'react'
import type { MediaGrant } from '@shared/media'
import { cn } from '@renderer/lib/utils'
import { VIDEO_BOX } from './boxes'
import { MediaCaption } from './media-caption'
import { MediaViewer, type PlayerMoment } from './media-viewer'
import { playOneAtATime } from './playback'

/** The tallest a clip shows in the thread; the viewer shows it larger. */
const MAX_HEIGHT = 480

/**
 * A clip a reply names, with Chromium's controls, in the images' frame: the column's width at its
 * own ratio, at most 480 px high. `onFailed` hears an error or a clip with no picture.
 */
export function LocalVideo({
  path,
  name,
  grant,
  onFailed,
}: {
  path: string
  name: string
  grant: MediaGrant
  onFailed: (message: string | null) => void
}) {
  const inline = useRef<HTMLVideoElement>(null)
  const [ratio, setRatio] = useState<{ width: number; height: number } | null>(null)
  const [seconds, setSeconds] = useState<number | null>(null)
  const [viewing, setViewing] = useState(false)
  const [moment, setMoment] = useState<PlayerMoment>({ time: 0, playing: false })
  useEffect(playOneAtATime, [])

  const box = ratio
    ? {
        width: `min(100%, ${(MAX_HEIGHT * ratio.width) / ratio.height}px)`,
        aspectRatio: `${ratio.width} / ${ratio.height}`,
      }
    : VIDEO_BOX

  const openLarger = () => {
    const el = inline.current
    if (!el) return
    setMoment({ time: el.currentTime, playing: !el.paused })
    el.pause()
    setViewing(true)
  }

  return (
    <span className="group/media block w-full">
      <span style={box} className="relative block overflow-hidden rounded-xl bg-card">
        <video
          ref={inline}
          src={grant.url}
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
          onError={(event) => {
            const error = event.currentTarget.error
            onFailed(error?.code === MediaError.MEDIA_ERR_NETWORK ? error.message || null : null)
          }}
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
        path={path}
        name={name}
        grant={grant}
        seconds={seconds}
        onOpenLarger={openLarger}
      />
      <MediaViewer
        open={viewing}
        onOpenChange={setViewing}
        grant={grant}
        name={name}
        moment={moment}
        onHandBack={(back) => {
          const el = inline.current
          if (!el) return
          el.currentTime = back.time
          if (back.playing) void el.play().catch(() => {})
        }}
      />
    </span>
  )
}
