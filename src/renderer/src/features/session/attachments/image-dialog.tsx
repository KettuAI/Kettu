import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AttachmentBytes } from '@shared/agent-host'
import { lineCount } from '@shared/attachments'
import { Button } from '@renderer/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '@renderer/components/ui/dialog'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { bytes as formatBytes } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'

export interface ImageDialogTarget {
  name: string
  /** Reads the full image or text: from the host's record in a draft, from the thread store once sent. */
  read: () => Promise<AttachmentBytes>
  /** A pasted text, shown as code. */
  text?: boolean
  /** Puts a pasted text back in the composer, which removes its tile. */
  pasteAsText?: (text: string) => void
}

/** An attached image at its full size, or a pasted text, read only while the dialog is open. */
export function ImageDialog({
  target,
  onClose,
}: {
  target: ImageDialogTarget | null
  onClose: () => void
}) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      {target?.text ? (
        <DialogContent className="w-2xl max-w-[90vw] gap-3 sm:max-w-[90vw]">
          <FullText target={target} onClose={onClose} />
        </DialogContent>
      ) : (
        <DialogContent className="w-auto max-w-[90vw] gap-3 sm:max-w-[90vw]">
          {target && <FullImage target={target} />}
        </DialogContent>
      )}
    </Dialog>
  )
}

type LoadedText =
  | { state: 'loading' }
  | { state: 'ready'; text: string; size: number }
  | { state: 'failed'; message: string }

function FullText({ target, onClose }: { target: ImageDialogTarget; onClose: () => void }) {
  const { t } = useTranslation('composer')
  const [loaded, setLoaded] = useState<LoadedText>({ state: 'loading' })

  useEffect(() => {
    let cancelled = false
    target.read().then(
      ({ bytes }) => {
        if (cancelled) return
        const text = new TextDecoder().decode(bytes)
        setLoaded({ state: 'ready', text, size: bytes.byteLength })
      },
      (error: unknown) => {
        if (!cancelled) setLoaded({ state: 'failed', message: errorMessage(error) })
      },
    )
    return () => {
      cancelled = true
    }
  }, [target])

  const paste = target.pasteAsText
  return (
    <>
      <div className="min-w-0 pr-8">
        <DialogTitle className="truncate text-ui">{target.name}</DialogTitle>
        {loaded.state === 'ready' && (
          <p className="text-meta text-tertiary tabular">
            {t('attachments.lines', { count: lineCount(loaded.text) })} · {formatBytes(loaded.size)}
          </p>
        )}
      </div>
      {loaded.state === 'ready' ? (
        <pre
          data-selectable=""
          className="max-h-[calc(85vh-9rem)] overflow-auto rounded-lg bg-code-block px-3 py-2.5 font-mono text-code whitespace-pre-wrap shadow-[inset_0_0_0_var(--hairline)_var(--border-subtle)] [overflow-wrap:anywhere]"
        >
          {loaded.text}
        </pre>
      ) : loaded.state === 'loading' ? (
        <Skeleton className="h-64 w-full rounded-lg" />
      ) : (
        <div>
          <p className="text-ui text-danger">{loaded.message}</p>
          <p className="text-meta text-tertiary">{t('attachments.cannotOpenText')}</p>
        </div>
      )}
      {paste && (
        <DialogFooter>
          <Button
            disabled={loaded.state !== 'ready'}
            onClick={() => {
              if (loaded.state !== 'ready') return
              onClose()
              paste(loaded.text)
            }}
          >
            {t('attachments.pasteAsText')}
          </Button>
        </DialogFooter>
      )}
    </>
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
