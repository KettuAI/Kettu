import { useContext, useMemo, useState } from 'react'
import { FileDownIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ContentRef } from '@shared/thread'
import { Button } from '@renderer/components/ui/button'
import { ProjectPathContext } from '@renderer/features/files/file-refs'
import { errorMessage } from '@renderer/lib/host'
import { openViewer } from '@renderer/stores/viewer'
import { saveCarried, type PlayedMedia } from './carried'
import { LocalAudio } from './local-audio'
import { MediaTitle, Placeholder, UnsupportedReason } from './local-media'
import { LocalVideo } from './local-video'
import { refKey } from './viewer-items'

/**
 * A sound or a clip the thread carries as bytes, by its index among its entry's refs, with the
 * players and caption row of files. Named by its resource's file name, or else by its kind. One
 * that cannot play says so and offers Save as…, since there is no file to open elsewhere. Without
 * a session and an entry, a clip opens no viewer.
 */
export function CarriedMedia({
  sessionId,
  entryId,
  index,
  carried,
}: {
  sessionId: string | null
  entryId: string | null
  index: number
  carried: Extract<ContentRef, { kind: 'audio' | 'video' }>
}) {
  const { t } = useTranslation('session')
  const projectPath = useContext(ProjectPathContext)
  const [failed, setFailed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { kind, mimeType, data, size } = carried
  const media = useMemo<PlayedMedia>(
    () => ({ kind: 'carried', mimeType, data, size }),
    [mimeType, data, size],
  )
  const name = carried.name ?? (kind === 'video' ? t('media.video') : t('media.sound'))

  if (failed) {
    return (
      <Placeholder
        title={<MediaTitle name={name} />}
        detail={
          <>
            <UnsupportedReason kind={kind} />
            {error && <span className="block text-danger">{error}</span>}
          </>
        }
        action={
          <Button
            variant="outline"
            size="xs"
            onClick={() => {
              setError(null)
              saveCarried(mimeType, data, name).catch((e: unknown) => setError(errorMessage(e)))
            }}
          >
            <FileDownIcon />
            {t('media.saveAs')}
          </Button>
        }
      />
    )
  }
  if (kind === 'audio') {
    return <LocalAudio media={media} name={name} onFailed={() => setFailed(true)} />
  }
  if (!sessionId || !entryId) {
    return <LocalVideo media={media} name={name} onFailed={() => setFailed(true)} />
  }
  const key = refKey(entryId, index)
  return (
    <LocalVideo
      media={media}
      name={name}
      viewerKey={key}
      onOpen={(from) =>
        openViewer({
          sessionId,
          projectPath,
          draft: sessionId,
          item: {
            key,
            source: { kind: 'bytes', media: 'video', mimeType, data },
            name: carried.name,
            alt: '',
          },
          from,
        })
      }
      onFailed={() => setFailed(true)}
    />
  )
}
