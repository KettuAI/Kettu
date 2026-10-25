import { useEffect, useState } from 'react'
import type { MediaGrant } from '@shared/media'
import { MediaCaption } from './media-caption'
import { playOneAtATime } from './playback'

/** A sound a reply names, with Chromium's audio controls, as wide as the column up to 420 px. */
export function LocalAudio({
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
  const [seconds, setSeconds] = useState<number | null>(null)
  useEffect(playOneAtATime, [])
  return (
    <span className="group/media block w-full max-w-[420px]">
      <audio
        src={grant.url}
        controls
        controlsList="nodownload"
        preload="metadata"
        aria-label={name}
        onLoadedMetadata={(event) => setSeconds(event.currentTarget.duration)}
        onError={(event) => {
          const error = event.currentTarget.error
          onFailed(error?.code === MediaError.MEDIA_ERR_NETWORK ? error.message || null : null)
        }}
        className="block w-full"
      />
      <MediaCaption path={path} name={name} grant={grant} seconds={seconds} />
    </span>
  )
}
