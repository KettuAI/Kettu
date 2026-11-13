import { useContext, useRef, useState } from 'react'
import { RefreshIcon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import type { ContentRef } from '@shared/thread'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { ProjectPathContext } from '@renderer/features/files/file-refs'
import { cn } from '@renderer/lib/utils'
import { openViewer } from '@renderer/stores/viewer'
import { FileCard, FileCardButton } from './file-card'
import { FRAME, FrameRing } from './frame'
import { useNearView } from './near-view'
import { useStoredImage } from './stored-image'
import { refKey, type ViewerSource } from './viewer-items'

export type CarriedImageRef = Extract<ContentRef, { kind: 'image' }>

/**
 * A picture the thread carries, by its index among its entry's refs, in the frame of a reply's
 * pictures, as a button that opens the viewer. One the host keeps in its thread store comes as
 * its hash, and its bytes are read once it nears the view. `className` sizes the picture; the
 * frame clips its corners and any shadow of its own. A `quiet` one that cannot be read shows
 * nothing, where a card would not fit.
 */
export function CarriedImage({
  sessionId,
  entryId,
  index,
  image,
  className,
  quiet = false,
}: {
  sessionId: string
  entryId: string
  index: number
  image: CarriedImageRef
  className?: string
  quiet?: boolean
}) {
  const { t } = useTranslation(['session', 'common'])
  const projectPath = useContext(ProjectPathContext)
  const key = refKey(entryId, index)
  const frame = useRef<HTMLButtonElement>(null)
  const hash = 'blob' in image ? image.blob : null
  const [attempt, setAttempt] = useState(0)
  const near = useNearView(frame, hash !== null)
  const stored = useStoredImage(sessionId, hash, near, attempt)
  const src =
    'data' in image
      ? `data:${image.mimeType};base64,${image.data}`
      : stored.state === 'ready'
        ? stored.url
        : null
  const source: ViewerSource =
    'data' in image
      ? { kind: 'bytes', media: 'image', mimeType: image.mimeType, data: image.data }
      : { kind: 'stored', hash: image.blob }

  if (stored.state === 'failed') {
    if (quiet) return null
    return (
      <FileCard
        name={t('viewer.image')}
        type={null}
        meta={t('media.cannotReadShort', { message: stored.message })}
        danger
        actions={
          <FileCardButton
            label={t('common:actions.retry')}
            onClick={() => setAttempt((n) => n + 1)}
          >
            <HugeiconsIcon icon={RefreshIcon} strokeWidth={1.9} aria-hidden className="size-3.5" />
          </FileCardButton>
        }
      />
    )
  }
  return (
    <button
      ref={frame}
      type="button"
      aria-label={t('media.openImage', { name: '' }).trim()}
      data-viewer-key={key}
      onClick={(event) =>
        openViewer({
          sessionId,
          projectPath,
          draft: sessionId,
          item: { key, source, name: null, alt: '' },
          from: event.currentTarget,
        })
      }
      className={cn(FRAME, 'group/media block w-fit max-w-full cursor-zoom-in focus-ring')}
    >
      {src ? (
        <img alt="" src={src} className={cn('block', className)} />
      ) : (
        <span className={cn('block size-24', className)}>
          {/* Shown only when the picture takes a while, so a quick one never flashes. */}
          <span className="block size-full animate-in fade-in fill-mode-both delay-200 duration-(--duration-fast)">
            <Skeleton render={<span />} className="block size-full rounded-none" />
          </span>
        </span>
      )}
      <FrameRing />
    </button>
  )
}
