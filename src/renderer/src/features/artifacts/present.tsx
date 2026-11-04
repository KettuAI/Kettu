import { useLayoutEffect, useRef, useState } from 'react'
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ARTIFACT_FRAME_SANDBOX, WEB_ARTIFACT_FRAME_SANDBOX } from '@shared/artifacts'
import { Dialog, DialogPortal, DialogTitle } from '@renderer/components/ui/dialog'
import { PanelButton } from '@renderer/features/shell/panel-button'
import { isWeb } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import type { PlacedPage } from './canvas'
import { pageUrl } from './use-artifact'

const MARGIN = 48
const BAR_ROOM = 72

/**
 * Presenting: the pages one at a time filling the window, live and interactive, with the arrows
 * and Space to move and Esc to leave; a single page fills it alone. The viewer stays under it.
 */
export function Presenter({
  url,
  version,
  title,
  pages,
  start,
  pageName,
  onExit,
}: {
  url: string
  version: number
  title: string
  /** A canvas's pages; null for a single page. */
  pages: PlacedPage[] | null
  start: number
  pageName: (index: number) => string
  onExit: (at: number) => void
}) {
  const { t } = useTranslation('artifacts')
  const [index, setIndex] = useState(Math.min(start, Math.max(0, (pages?.length ?? 1) - 1)))
  const count = pages?.length ?? 1
  const page = pages?.[index] ?? null
  const stage = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)

  useLayoutEffect(() => {
    const el = stage.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const move = (step: number) => setIndex((at) => Math.max(0, Math.min(count - 1, at + step)))
  const name = pages ? pageName(index) : title

  // A page as large as fits the window, larger than its size too; a single page is the window.
  const box =
    size && page
      ? (() => {
          const scale = Math.min(
            (size.width - 2 * MARGIN) / page.width,
            (size.height - MARGIN - BAR_ROOM) / page.height,
          )
          return { scale, width: page.width * scale, height: page.height * scale }
        })()
      : null

  return (
    <Dialog open onOpenChange={(open) => !open && onExit(index)}>
      <DialogPortal>
        <DialogPrimitive.Popup
          data-theme="dark"
          data-overlay-layer=""
          initialFocus={stage}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget && event.target !== stage.current) return
            if (event.key === 'ArrowRight' || (event.key === ' ' && !event.shiftKey)) move(1)
            else if (event.key === 'ArrowLeft' || (event.key === ' ' && event.shiftKey)) move(-1)
            else return
            event.preventDefault()
          }}
          className="fixed inset-0 z-50 flex animate-in flex-col bg-viewer-scrim text-foreground outline-none fade-in duration-(--duration-fast) app-region-no-drag"
        >
          <DialogTitle className="sr-only">{t('present.label', { title })}</DialogTitle>
          <div
            ref={stage}
            tabIndex={-1}
            className="relative flex min-h-0 flex-1 items-center justify-center outline-none"
            style={{ paddingBottom: page ? BAR_ROOM - MARGIN / 2 : 0 }}
          >
            {page && box ? (
              <div
                className="relative shrink-0 overflow-hidden rounded-lg bg-canvas shadow-(--elevation-page)"
                style={{ width: box.width, height: box.height }}
              >
                <iframe
                  key={`${page.group}.${page.index}`}
                  src={pageUrl(url, version, page)}
                  title={name}
                  sandbox={isWeb ? WEB_ARTIFACT_FRAME_SANDBOX : ARTIFACT_FRAME_SANDBOX}
                  allow=""
                  referrerPolicy="no-referrer"
                  style={{
                    width: page.width,
                    height: page.height,
                    transform: `scale(${box.scale})`,
                  }}
                  className="block origin-top-left border-0"
                />
              </div>
            ) : (
              !pages && (
                <iframe
                  src={pageUrl(url, version)}
                  title={name}
                  sandbox={isWeb ? WEB_ARTIFACT_FRAME_SANDBOX : ARTIFACT_FRAME_SANDBOX}
                  allow=""
                  referrerPolicy="no-referrer"
                  className="absolute inset-0 size-full border-0 bg-canvas"
                />
              )
            )}
          </div>
          <div
            role="toolbar"
            aria-label={t('present.controls')}
            className={cn(
              'absolute bottom-5 left-1/2 flex h-10 -translate-x-1/2 items-center gap-1 rounded-2xl bg-toast/80 px-1.5 text-toast-foreground shadow-menu backdrop-blur-sm',
            )}
          >
            {pages && (
              <>
                <PanelButton
                  size="icon-sm"
                  label={t('canvas.previous')}
                  shortcut="←"
                  disabled={index === 0}
                  onClick={() => move(-1)}
                >
                  <ChevronLeftIcon />
                </PanelButton>
                <span className="min-w-28 px-2 text-center text-ui tabular-nums">
                  {t('present.position', { name, number: index + 1, count })}
                </span>
                <PanelButton
                  size="icon-sm"
                  label={t('canvas.next')}
                  shortcut="→"
                  disabled={index === count - 1}
                  onClick={() => move(1)}
                >
                  <ChevronRightIcon />
                </PanelButton>
                <span aria-hidden className="mx-1 h-4 w-(--hairline) bg-toast-muted" />
              </>
            )}
            <button
              type="button"
              onClick={() => onExit(index)}
              className="rounded-xl px-2.5 py-1 text-ui text-toast-muted outline-none transition-colors duration-(--duration-fast) hover:text-toast-foreground focus-ring"
            >
              {t('present.exit')}
            </button>
          </div>
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  )
}
