import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import { ExternalLinkIcon, PlayIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ProjectPathContext } from '@renderer/features/files/file-refs'
import { bytes as formatBytes, clock, duration } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { hostOfPath } from '@renderer/lib/host-paths'
import { isWeb } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { VIDEO_BOX } from './boxes'
import { playedUrl, type PlayedMedia } from './carried'
import { playerFailure } from './failure'
import { FRAME, FrameCaption, FrameRing, MEDIA_MAX_WIDTH } from './frame'
import { playOneAtATime } from './playback'

/** The tallest a clip shows in the thread; the viewer shows it larger. */
const MAX_HEIGHT = 480

/** The speeds the poster's speed button steps through. */
const RATES = [1, 1.5, 2] as const

/**
 * A clip a reply names or the thread carries, in the images' frame: its first frame under a play
 * button, with its time, length and speed along the bottom, at most 600 px wide and 480 px high.
 * It never plays by itself and starts muted; once it plays, Chromium's own controls take over.
 * The frame opens the viewer, which takes over the player's moment; without `onOpen` it opens
 * none. `onFailed` hears an error or a clip with no picture.
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
  const { t } = useTranslation('session')
  const projectPath = useContext(ProjectPathContext)
  const frame = useRef<HTMLSpanElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const src = useMemo(() => playedUrl(media), [media])
  const [ratio, setRatio] = useState<{ width: number; height: number } | null>(null)
  const [seconds, setSeconds] = useState<number | null>(null)
  const [time, setTime] = useState(0)
  const [rate, setRate] = useState(1)
  const [started, setStarted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(playOneAtATime, [])

  const box = ratio
    ? {
        width: `min(100%, ${MEDIA_MAX_WIDTH}px, ${(MAX_HEIGHT * ratio.width) / ratio.height}px)`,
        aspectRatio: `${ratio.width} / ${ratio.height}`,
      }
    : { ...VIDEO_BOX, maxWidth: MEDIA_MAX_WIDTH }
  const length = seconds !== null && Number.isFinite(seconds) ? seconds : null
  // Another host's file has no app of this computer's to open it, nor carried bytes a file.
  const external =
    media.kind === 'file' &&
    !isWeb &&
    (projectPath === null || hostOfPath(projectPath) === null) &&
    media.grant.url
  const size = formatBytes(media.kind === 'file' ? media.grant.size : media.size)

  const play = () => {
    const player = video.current
    if (!player) return
    player.muted = true
    void player.play().catch(() => {})
  }
  const nextRate = () => {
    const next = RATES[(RATES.indexOf(rate as (typeof RATES)[number]) + 1) % RATES.length]!
    if (video.current) video.current.playbackRate = next
    setRate(next)
  }
  const openExternal = (url: string) => {
    setError(null)
    window.kettu.media.openExternal(url).catch((e: unknown) => setError(errorMessage(e)))
  }

  return (
    <span className="block w-full">
      <span
        ref={frame}
        data-viewer-key={viewerKey}
        style={box}
        className={cn(FRAME, 'group/media block')}
      >
        <video
          ref={video}
          src={src}
          controls={started}
          controlsList="nodownload"
          preload="metadata"
          muted
          playsInline
          aria-label={name}
          onPlay={() => setStarted(true)}
          // The poster's time and bar show only until it plays.
          onTimeUpdate={(event) => !started && setTime(event.currentTarget.currentTime)}
          onRateChange={(event) => setRate(event.currentTarget.playbackRate)}
          onLoadedMetadata={(event) => {
            const { videoWidth, videoHeight } = event.currentTarget
            // Chromium loads some formats, such as ProRes, with sound and a picture of 0 x 0.
            if (videoWidth === 0 || videoHeight === 0) {
              onFailed(null)
              return
            }
            setRatio({ width: videoWidth, height: videoHeight })
            setSeconds(event.currentTarget.duration)
          }}
          onError={(event) => onFailed(playerFailure(event.currentTarget))}
          className="block size-full object-contain"
        />
        {!started && (
          <>
            {onOpen ? (
              <button
                type="button"
                aria-label={t('media.openLarger')}
                onClick={() => frame.current && onOpen(frame.current)}
                className="absolute inset-0 cursor-zoom-in rounded-[inherit] outline-none focus-visible:shadow-[inset_0_0_0_1.5px_var(--focus-ring-color)]"
              />
            ) : null}
            <span
              aria-hidden
              className="pointer-events-none absolute inset-0 bg-linear-to-b from-transparent from-60% to-(--media-shade)"
            />
            <button
              type="button"
              aria-label={t('media.play', { name })}
              onClick={play}
              className="absolute top-[45%] left-1/2 grid size-12 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-(--media-control) text-(color:--media-control-ink) shadow-media-control transition-transform duration-(--duration-fast) focus-ring hover:scale-105 active:scale-100"
            >
              <PlayIcon className="size-4.5" strokeWidth={1.6} />
            </button>
            <span className="pointer-events-none absolute inset-x-3 bottom-2.5 flex items-center gap-2.5 text-caption text-(color:--media-foreground) tabular">
              <span>{clock(time)}</span>
              <span aria-hidden className="h-0.75 flex-1 rounded-full bg-(--media-track)">
                <span
                  className="block h-full rounded-full bg-(--media-foreground)"
                  style={{ width: length ? `${Math.min(100, (time / length) * 100)}%` : 0 }}
                />
              </span>
              {length !== null && <span>{clock(length)}</span>}
              <button
                type="button"
                aria-label={t('media.speed', { rate })}
                onClick={nextRate}
                className="pointer-events-auto rounded-sm opacity-85 focus-ring hover:opacity-100"
              >
                {t('media.rate', { rate })}
              </button>
              {external && (
                <button
                  type="button"
                  aria-label={t('media.openWithDefault')}
                  title={t('media.openWithDefault')}
                  onClick={() => openExternal(external)}
                  className="pointer-events-auto grid place-items-center rounded-sm opacity-85 focus-ring hover:opacity-100"
                >
                  <ExternalLinkIcon className="size-3.25" strokeWidth={1.5} />
                </button>
              )}
            </span>
          </>
        )}
        <FrameRing />
      </span>
      <FrameCaption title={media.kind === 'file' ? media.path : name}>
        {[name, length !== null && duration(length * 1000), size].filter(Boolean).join(' · ')}
      </FrameCaption>
      {error && <span className="mt-0.5 block truncate text-meta text-danger">{error}</span>}
    </span>
  )
}
