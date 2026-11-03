import { useContext } from 'react'
import { useTranslation } from 'react-i18next'
import { ProjectPathContext } from '@renderer/features/files/file-refs'
import { cn } from '@renderer/lib/utils'
import { openViewer } from '@renderer/stores/viewer'
import { FRAME, FrameRing } from './frame'
import { refKey } from './viewer-items'

/**
 * A picture the thread carries as bytes, by its index among its entry's refs, in the frame of a
 * reply's pictures, as a button that opens the viewer. `className` sizes the picture; the frame
 * clips its corners and any shadow of its own.
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
      className={cn(FRAME, 'group/media block w-fit max-w-full cursor-zoom-in focus-ring')}
    >
      <img alt="" src={`data:${mimeType};base64,${data}`} className={cn('block', className)} />
      <FrameRing />
    </button>
  )
}
