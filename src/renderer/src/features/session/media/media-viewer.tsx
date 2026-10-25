import { useEffect, useRef, useState } from 'react'
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

/** Where a clip is and whether it plays, which the viewer takes over and hands back. */
export interface PlayerMoment {
  time: number
  playing: boolean
}

/**
 * The plain viewer: the picture or the clip fitted over the whole window on a dark scrim, with
 * its name and sizes, closed by Close, `Esc` or a click beside it. A clip goes on from the inline
 * player's `moment` and hands its own back through `onHandBack` when the viewer closes.
 */
export function MediaViewer({
  open,
  onOpenChange,
  grant,
  name,
  alt = '',
  moment,
  onHandBack,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  grant: MediaGrant
  name: string
  alt?: string
  moment?: PlayerMoment
  onHandBack?: (moment: PlayerMoment) => void
}) {
  const { t } = useTranslation('common')
  const [pixels, setPixels] = useState(
    grant.width && grant.height ? `${grant.width} × ${grant.height}` : null,
  )
  const video = useRef<HTMLVideoElement>(null)

  const takeOver = () => {
    const el = video.current
    if (!el || !moment) return
    el.currentTime = moment.time
    if (moment.playing) void el.play().catch(() => {})
  }
  // A viewer kept from an earlier opening has its metadata already, so no event comes.
  useEffect(() => {
    if (open && (video.current?.readyState ?? 0) >= HTMLMediaElement.HAVE_METADATA) takeOver()
    // Only on opening: the moment is the one the inline player had then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const change = (next: boolean) => {
    const el = video.current
    if (!next && el) {
      const playing = !el.paused
      el.pause()
      onHandBack?.({ time: el.currentTime, playing })
    }
    onOpenChange(next)
  }

  return (
    <Dialog open={open} onOpenChange={change}>
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
              if (event.target === event.currentTarget) change(false)
            }}
          >
            {grant.kind === 'video' ? (
              <video
                ref={video}
                src={grant.url}
                controls
                controlsList="nodownload"
                preload="metadata"
                aria-label={name}
                onLoadedMetadata={(event) => {
                  const { videoWidth, videoHeight } = event.currentTarget
                  setPixels(`${videoWidth} × ${videoHeight}`)
                  takeOver()
                }}
                className="max-h-full max-w-full bg-card"
              />
            ) : (
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
            )}
          </div>
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  )
}
