import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AttachmentBytes } from '@shared/agent-host'
import { Dialog, DialogContent, DialogTitle } from '@renderer/components/ui/dialog'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { bytes as formatBytes } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'

export interface ImageDialogTarget {
  name: string
  /** Reads the full image: from the host's record in a draft, from the thread store once sent. */
  read: () => Promise<AttachmentBytes>
}

/** An attached image at its full size, read only while the dialog is open. */
export function ImageDialog({
  target,
  onClose,
}: {
  target: ImageDialogTarget | null
  onClose: () => void
}) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="w-auto max-w-[90vw] gap-3 sm:max-w-[90vw]">
        {target && <FullImage target={target} />}
      </DialogContent>
    </Dialog>
  )
}

type Loaded =
  | { state: 'loading' }
  | { state: 'ready'; url: string; size: number; pixels: string | null }
  | { state: 'failed'; message: string }

function FullImage({ target }: { target: ImageDialogTarget }) {
  const { t } = useTranslation('composer')
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' })

  useEffect(() => {
    let url: string | null = null
    let cancelled = false
    target.read().then(
      ({ mimeType, bytes }) => {
        if (cancelled) return
        url = URL.createObjectURL(new Blob([bytes], { type: mimeType }))
        setLoaded({ state: 'ready', url, size: bytes.byteLength, pixels: null })
      },
      (error: unknown) => {
        if (!cancelled) setLoaded({ state: 'failed', message: errorMessage(error) })
      },
    )
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [target])

  return (
    <>
      {loaded.state === 'ready' ? (
        <img
          src={loaded.url}
          alt={target.name}
          onLoad={(event) => {
            const { naturalWidth, naturalHeight } = event.currentTarget
            setLoaded((current) =>
              current.state === 'ready'
                ? { ...current, pixels: `${naturalWidth} × ${naturalHeight}` }
                : current,
            )
          }}
          className="max-h-[calc(85vh-6rem)] max-w-full rounded-lg object-contain shadow-card checkerboard"
        />
      ) : loaded.state === 'loading' ? (
        <Skeleton className="h-64 w-96 max-w-full rounded-lg" />
      ) : (
        <p className="w-96 max-w-full text-ui text-danger">{loaded.message}</p>
      )}
      <div className="min-w-0 pr-8">
        <DialogTitle className="truncate text-ui">{target.name}</DialogTitle>
        {loaded.state === 'ready' && (
          <p className="text-meta text-tertiary tabular">
            {[loaded.pixels, formatBytes(loaded.size)].filter(Boolean).join(' · ')}
          </p>
        )}
        {loaded.state === 'failed' && (
          <p className="text-meta text-tertiary">{t('attachments.cannotOpen')}</p>
        )}
      </div>
    </>
  )
}
