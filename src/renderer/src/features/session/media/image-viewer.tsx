import { useState } from 'react'
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import { XIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { MediaGrant } from '@shared/media'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { bytes as formatBytes } from '@renderer/lib/format'
import { isMac } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'

/**
 * The plain viewer of the media design's first version: the picture fitted over the whole window
 * on a dark scrim, with its name and sizes, closed by Close, `Esc` or a click beside it. See
 * docs/design/ui.md#viewer.
 */
export function ImageViewer({
  open,
  onOpenChange,
  grant,
  name,
  alt,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  grant: MediaGrant
  name: string
  alt: string
}) {
  const { t } = useTranslation('common')
  const [pixels, setPixels] = useState(
    grant.width && grant.height ? `${grant.width} × ${grant.height}` : null,
  )
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay className="bg-viewer-scrim duration-(--duration-base) supports-backdrop-filter:backdrop-blur-none" />
        {/* The dialog's own popup is a centred card; the viewer takes the whole window. */}
        <DialogPrimitive.Popup
          // The bar and its buttons read on the dark scrim in either theme.
          data-theme="dark"
          className="fixed inset-0 z-50 flex flex-col text-foreground outline-none app-region-no-drag duration-(--duration-base) data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
        >
          <div
            className={cn(
              'flex h-top-bar shrink-0 items-center gap-2 pr-2.5 pl-5 app-region-drag',
              isMac
                ? 'pl-[calc(32px+var(--traffic-lights))]'
                : 'pr-[calc(100vw-env(titlebar-area-x,0px)-env(titlebar-area-width,100vw)+10px)]',
            )}
          >
            <DialogTitle className="min-w-0 truncate font-sans text-ui leading-normal">
              {name}
            </DialogTitle>
            <span className="shrink-0 text-meta text-tertiary tabular">
              {[pixels, formatBytes(grant.size)].filter(Boolean).join(' · ')}
            </span>
            <span className="flex-1" />
            <DialogClose
              render={<Button variant="ghost" size="icon-sm" className="app-region-no-drag" />}
            >
              <XIcon />
              <span className="sr-only">{t('actions.close')}</span>
            </DialogClose>
          </div>
          <div
            className="flex min-h-0 flex-1 items-center justify-center p-12"
            onClick={(event) => {
              if (event.target === event.currentTarget) onOpenChange(false)
            }}
          >
            <img
              src={grant.url}
              alt={alt}
              decoding="async"
              onLoad={(event) => {
                const { naturalWidth, naturalHeight } = event.currentTarget
                setPixels(`${naturalWidth} × ${naturalHeight}`)
              }}
              className="max-h-full max-w-full bg-card object-contain checkerboard"
            />
          </div>
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  )
}
