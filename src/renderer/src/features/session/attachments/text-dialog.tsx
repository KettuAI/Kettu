import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AttachmentBytes } from '@shared/agent-host'
import { lineCount } from '@shared/attachments'
import { Button } from '@renderer/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '@renderer/components/ui/dialog'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { bytes as formatBytes } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'

export interface TextDialogTarget {
  name: string
  /** Reads the full text: from the host's record in a draft, from the thread store once sent. */
  read: () => Promise<AttachmentBytes>
  /** Puts a pasted text back in the composer, which removes its tile. */
  pasteAsText?: (text: string) => void
}

/** A pasted text in full, read only while the dialog is open; attached images open the viewer. */
export function TextDialog({
  target,
  onClose,
}: {
  target: TextDialogTarget | null
  onClose: () => void
}) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="w-2xl max-w-[90vw] gap-3 sm:max-w-[90vw]">
        {target && <FullText target={target} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  )
}

type LoadedText =
  | { state: 'loading' }
  | { state: 'ready'; text: string; size: number }
  | { state: 'failed'; message: string }

function FullText({ target, onClose }: { target: TextDialogTarget; onClose: () => void }) {
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
