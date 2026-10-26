import { useEffect, useMemo, useState } from 'react'
import { playedUrl, type PlayedMedia } from './carried'
import { playerFailure } from './failure'
import { MediaCaption } from './media-caption'
import { playOneAtATime } from './playback'

/**
 * A sound a reply names or the thread carries, with Chromium's audio controls, as wide as the
 * column up to 420 px.
 */
export function LocalAudio({
  media,
  name,
  onFailed,
}: {
  media: PlayedMedia
  name: string
  onFailed: (message: string | null) => void
}) {
  const [seconds, setSeconds] = useState<number | null>(null)
  const src = useMemo(() => playedUrl(media), [media])
  useEffect(playOneAtATime, [])
  return (
    <span className="group/media block w-full max-w-[420px]">
      <audio
        src={src}
        controls
        controlsList="nodownload"
        preload="metadata"
        aria-label={name}
        onLoadedMetadata={(event) => setSeconds(event.currentTarget.duration)}
        onError={(event) => onFailed(playerFailure(event.currentTarget))}
        className="block w-full"
      />
      <MediaCaption media={media} name={name} seconds={seconds} />
    </span>
  )
}
