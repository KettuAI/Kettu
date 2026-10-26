import { useContext } from 'react'
import { useTranslation } from 'react-i18next'
import { ProjectPathContext } from '@renderer/features/files/file-refs'
import { cn } from '@renderer/lib/utils'
import { openViewer } from '@renderer/stores/viewer'
import { refKey } from './viewer-items'

/**
 * A picture the thread carries as bytes, by its index among its entry's refs, as a button that
 * opens the viewer.
 */
export function CarriedImage({
  sessionId,
  entryId,
  index,
  mimeType,
  data,
  className,
}: {
  sessionId: string
  entryId: string
  index: number
  mimeType: string
  data: string
  className?: string
}) {
  const { t } = useTranslation('session')
  const projectPath = useContext(ProjectPathContext)
  const key = refKey(entryId, index)
  return (
    <button
      type="button"
      aria-label={t('media.openImage', { name: '' }).trim()}
      data-viewer-key={key}
      onClick={(event) =>
        openViewer({
          sessionId,
          projectPath,
          draft: sessionId,
          item: {
            key,
            source: { kind: 'bytes', media: 'image', mimeType, data },
            name: null,
            alt: '',
          },
          from: event.currentTarget,
        })
      }
      className="block max-w-full cursor-zoom-in rounded-lg focus-ring"
    >
      <img alt="" src={`data:${mimeType};base64,${data}`} className={cn('block', className)} />
    </button>
  )
}
