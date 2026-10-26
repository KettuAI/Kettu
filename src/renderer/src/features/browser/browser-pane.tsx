import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ExternalLinkIcon,
  GlobeIcon,
  Maximize2Icon,
  Minimize2Icon,
  RotateCwIcon,
  XIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { BrowserNotice } from '@shared/browser'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@renderer/components/ui/empty'
import { PanelButton } from '@renderer/features/shell/panel-button'
import { SHEET } from '@renderer/features/shell/sheet'
import { SidebarToggle } from '@renderer/features/shell/top-bar'
import { isMac } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { useBrowserStore } from '@renderer/stores/browser'
import { useOverlayOpen } from '@renderer/stores/overlays'
import { useSettingsStore } from '@renderer/stores/settings'
import { toggleSidePane, useViewStore } from '@renderer/stores/view'
import { AddressField } from './address-field'

/** The side panel's third pane: one page per session, drawn by main over the pane's page area. */
export function BrowserPane({
  projectPath,
  maximized,
}: {
  projectPath: string
  maximized: boolean
}) {
  const { t } = useTranslation(['browser', 'common'])
  const sessionId = useViewStore((s) => (s.main.kind === 'session' ? s.main.sessionId : null))
  const state = useBrowserStore((s) => (sessionId ? s.bySession[sessionId] : undefined))
  const still = useBrowserStore((s) => (sessionId ? s.stills[sessionId] : undefined))
  const overlayOpen = useOverlayOpen()
  const cornered = useViewStore((s) => s.sidebarCollapsed) && maximized && isMac
  const zoom = useSettingsStore((s) => s.settings.appearance.zoom)
  const sheet = useRef<HTMLDivElement>(null)
  const page = useRef<HTMLDivElement>(null)

  const navigate = (url: string) => {
    if (sessionId) void window.overbench.browser.navigate(sessionId, url)
  }

  // Main shows the session's page while the pane is open, and keeps it while the pane is hidden.
  useEffect(() => {
    if (!sessionId) return
    void window.overbench.browser.show(sessionId)
    return () => {
      void window.overbench.browser.hide(sessionId)
    }
  }, [sessionId])

  // The page's area, in the window's own pixels: the renderer's zoom scales CSS pixels. The page
  // fills the sheet's lower corners, which the sheet cannot clip on a native view, so main rounds
  // them on the page.
  const report = useCallback(() => {
    const element = page.current
    if (!element || !sheet.current || !sessionId) return
    const rect = element.getBoundingClientRect()
    const radius = parseFloat(getComputedStyle(sheet.current).borderBottomLeftRadius) || 0
    void window.overbench.browser.setBounds(sessionId, {
      x: Math.round(rect.left * zoom),
      y: Math.round(rect.top * zoom),
      width: Math.round(rect.width * zoom),
      height: Math.round(rect.height * zoom),
      radius: Math.round(radius * zoom),
    })
  }, [sessionId, zoom])

  // A notice or the progress bar moves the page's area without resizing it.
  useLayoutEffect(report)

  useLayoutEffect(() => {
    const element = page.current
    if (!element) return
    const observer = new ResizeObserver(report)
    observer.observe(element)
    window.addEventListener('resize', report)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
    }
  }, [report])

  // An overlay that covers the page takes a still in its place: a web view is a native layer the
  // renderer cannot draw over.
  useEffect(() => {
    if (!sessionId) return
    if (!overlayOpen) {
      if (!useBrowserStore.getState().stills[sessionId]) return
      void window.overbench.browser.thaw(sessionId).finally(() => {
        useBrowserStore.getState().setStill(sessionId, null)
      })
      return
    }
    let cancelled = false
    const frame = requestAnimationFrame(() => {
      const area = page.current
      if (!area || !covers(area)) return
      void window.overbench.browser
        .freeze(sessionId)
        .then((image) => {
          // The overlay may have closed while the page was captured; then nothing is shown.
          if (!image) return
          if (cancelled) void window.overbench.browser.thaw(sessionId)
          else useBrowserStore.getState().setStill(sessionId, image)
        })
        .catch(() => {})
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
    }
  }, [overlayOpen, sessionId])

  // Leaving the pane or its session drops a still that is no longer in front of anything.
  useEffect(() => {
    if (!sessionId) return
    return () => {
      if (!useBrowserStore.getState().stills[sessionId]) return
      void window.overbench.browser.thaw(sessionId)
      useBrowserStore.getState().setStill(sessionId, null)
    }
  }, [sessionId])

  const hasPage = !!state?.url

  return (
    <div
      ref={sheet}
      className={cn(
        'flex h-full min-h-0 animate-in flex-col fade-in animation-duration-(--duration-fast)',
        SHEET,
        maximized && 'absolute inset-0 z-10',
      )}
      data-browser-panel=""
    >
      <div
        className={cn(
          'app-region-drag flex h-top-bar shrink-0 items-center gap-0.5 pr-2 pl-2 shadow-[inset_0_calc(-1*var(--hairline))_0_var(--border-subtle)]',
          cornered && 'pl-[calc(32px-var(--sheet-gap)+var(--traffic-lights))]',
        )}
      >
        {cornered && <SidebarToggle className="mr-1" />}
        <div className="app-region-no-drag flex min-w-0 items-center gap-0.5">
          <PanelButton
            label={t('actions.back')}
            shortcut={isMac ? '⌘[' : 'Ctrl+['}
            disabled={!state?.canGoBack}
            onClick={() => sessionId && void window.overbench.browser.back(sessionId)}
          >
            <ArrowLeftIcon className="size-3.5" />
          </PanelButton>
          <PanelButton
            label={t('actions.forward')}
            shortcut={isMac ? '⌘]' : 'Ctrl+]'}
            disabled={!state?.canGoForward}
            onClick={() => sessionId && void window.overbench.browser.forward(sessionId)}
          >
            <ArrowRightIcon className="size-3.5" />
          </PanelButton>
          {state?.loading ? (
            <PanelButton
              label={t('actions.stop')}
              onClick={() => sessionId && void window.overbench.browser.stop(sessionId)}
            >
              <XIcon className="size-3.5" />
            </PanelButton>
          ) : (
            <PanelButton
              label={t('actions.reload')}
              shortcut={isMac ? '⌘R' : 'Ctrl+R'}
              disabled={!hasPage}
              onClick={() => sessionId && void window.overbench.browser.reload(sessionId)}
            >
              <RotateCwIcon className="size-3.5" />
            </PanelButton>
          )}
        </div>
        {hasPage && state?.url ? (
          <AddressField url={state.url} onNavigate={navigate} className="mx-1.5 flex-1" />
        ) : (
          <span className="min-w-2 flex-1" />
        )}
        <div className="app-region-no-drag flex items-center gap-0.5">
          <PanelButton
            label={t('actions.openExternal')}
            disabled={!hasPage}
            onClick={() => sessionId && void window.overbench.browser.openExternal(sessionId)}
          >
            <ExternalLinkIcon className="size-3.5" />
          </PanelButton>
          <PanelButton
            label={maximized ? t('actions.restore') : t('actions.maximize')}
            onClick={() => useViewStore.setState({ sidePaneMaximized: !maximized })}
          >
            {maximized ? (
              <Minimize2Icon className="size-3.5" />
            ) : (
              <Maximize2Icon className="size-3.5" />
            )}
          </PanelButton>
          <PanelButton
            label={t('common:actions.close')}
            onClick={() => toggleSidePane(projectPath, 'browser', false)}
          >
            <XIcon className="size-3.5" />
          </PanelButton>
        </div>
      </div>
      {state?.loading && (
        <div
          role="progressbar"
          aria-label={t('loading')}
          className="h-0.5 shrink-0 overflow-hidden bg-track"
        >
          <div className="h-full w-full animate-pulse bg-info" />
        </div>
      )}
      {state?.notice && <Notice notice={state.notice} sessionId={sessionId} />}
      <div ref={page} className="relative min-h-0 flex-1 bg-background">
        {!hasPage && (
          <div className="flex h-full items-center justify-center px-6">
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <GlobeIcon />
                </EmptyMedia>
                <EmptyTitle>{sessionId ? t('empty.title') : t('empty.noSession')}</EmptyTitle>
                {!sessionId && <EmptyDescription>{t('empty.noSessionHint')}</EmptyDescription>}
              </EmptyHeader>
              {sessionId && (
                <div className="w-full max-w-sm">
                  <AddressField url={null} onNavigate={navigate} autoFocus />
                </div>
              )}
            </Empty>
          </div>
        )}
        {still && (
          <img
            src={still}
            alt=""
            aria-hidden
            className="pointer-events-none absolute inset-0 h-full w-full object-fill"
          />
        )}
      </div>
    </div>
  )
}

/** A blocked download, a page lost to make room, or a page that did not load. */
function Notice({ notice, sessionId }: { notice: BrowserNotice; sessionId: string | null }) {
  const { t } = useTranslation('browser')
  const open = () => {
    if (sessionId) void window.overbench.browser.openExternal(sessionId)
  }
  return (
    <div className="flex min-h-8 shrink-0 items-center gap-2 bg-subtle px-3 text-small text-secondary">
      <span className="min-w-0 flex-1 truncate">
        {notice.kind === 'download-blocked' && t('notice.downloadBlocked')}
        {notice.kind === 'evicted' && t('notice.evicted')}
        {notice.kind === 'load-failed' && t('notice.loadFailed', { error: notice.description })}
      </span>
      {notice.kind === 'download-blocked' && (
        <button
          type="button"
          onClick={open}
          className="shrink-0 text-small text-link hover:underline focus-ring"
        >
          {t('actions.openExternal')}
        </button>
      )}
      {notice.kind !== 'download-blocked' && sessionId && (
        <button
          type="button"
          onClick={() => void window.overbench.browser.reload(sessionId)}
          className="shrink-0 text-small text-link hover:underline focus-ring"
        >
          {notice.kind === 'evicted' ? t('actions.reload') : t('actions.tryAgain')}
        </button>
      )}
    </div>
  )
}

/** Whether an open overlay covers the page's area. */
function covers(area: Element): boolean {
  const bounds = area.getBoundingClientRect()
  for (const overlay of document.querySelectorAll('[data-overlay-layer]')) {
    if (overlay.closest('[data-closed]')) continue
    const rect = overlay.getBoundingClientRect()
    const apart =
      rect.right <= bounds.left ||
      rect.left >= bounds.right ||
      rect.bottom <= bounds.top ||
      rect.top >= bounds.bottom
    if (!apart) return true
  }
  return false
}
