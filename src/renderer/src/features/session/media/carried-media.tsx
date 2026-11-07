import { useContext, useMemo, useState } from 'react'
import { Download01Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import type { ContentRef } from '@shared/thread'
import { ProjectPathContext } from '@renderer/features/files/file-refs'
import { bytes } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { openViewer } from '@renderer/stores/viewer'
import { saveCarried, type PlayedMedia } from './carried'
import { FileCard, FileCardButton } from './file-card'
import { fileType, REASONS } from './layout'
import { LocalAudio } from './local-audio'
import { LocalVideo } from './local-video'
import { refKey } from './viewer-items'

/**
 * A sound or a clip the thread carries as bytes, by its index among its entry's refs, with the
 * players and caption row of files. Named by its resource's file name, or else by its kind. One
 * that cannot play becomes a file card that offers Download, since there is no file to open
 * elsewhere. Without a session and an entry, a clip opens no viewer.
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
      <FileCard
        name={name}
        type={fileType(carried.name ?? '', mimeType)}
        meta={error ?? `${bytes(size)} · ${t(REASONS[kind])}`}
        danger={error !== null}
        actions={
          <FileCardButton
            label={t('media.download')}
            onClick={() => {
              setError(null)
              saveCarried(mimeType, data, name).catch((e: unknown) => setError(errorMessage(e)))
            }}
          >
            <HugeiconsIcon
              icon={Download01Icon}
              strokeWidth={1.9}
              aria-hidden
              className="size-3.5"
            />
          </FileCardButton>
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
