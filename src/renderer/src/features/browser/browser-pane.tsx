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
import { CornerControls } from '@renderer/features/shell/top-bar'
import { hasBand, isMac } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { agentName } from '@renderer/stores/agents'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useBrowserStore } from '@renderer/stores/browser'
import { useOverlayOpen } from '@renderer/stores/overlays'
import { useSettingsStore } from '@renderer/stores/settings'
import { toggleSidePane, useViewStore } from '@renderer/stores/view'
import { AddressField } from './address-field'
import { DrivingBar } from './driving-bar'
import { OriginBar } from './origin-bar'

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
  const hidden = useBrowserStore((s) => (sessionId ? !!s.unseen[sessionId] : false))
  const agentId = useSessionsStore((s) => (sessionId ? s.byId[sessionId]?.agentId : null))
  const overlayOpen = useOverlayOpen()
  const cornered = useViewStore((s) => s.sidebarCollapsed) && maximized && !hasBand
  const zoom = useSettingsStore((s) => s.settings.appearance.zoom)
  const sheet = useRef<HTMLDivElement>(null)
  // The area the page fills; the 2 px info frame around it sits outside this box.
  const page = useRef<HTMLDivElement>(null)

  // The pane shows the page, so the toggle's dot has done its work.
  useEffect(() => {
    if (sessionId) useBrowserStore.getState().seen(sessionId)
  }, [sessionId, hidden])

  const navigate = (url: string) => {
    if (sessionId) void window.kettu.browser.navigate(sessionId, url)
  }

  // Main shows the session's page while the pane is open, and keeps it while the pane is hidden.
  useEffect(() => {
    if (!sessionId) return
    void window.kettu.browser.show(sessionId)
    return () => {
      void window.kettu.browser.hide(sessionId)
    }
  }, [sessionId])

  // The page's area, in the window's own pixels: the renderer's zoom scales CSS pixels. The page
  // fills the sheet's lower corners, which the sheet cannot clip on a native view, so main rounds
  // them on the page. The 2 px info frame is outside this area, so it stays visible while an
  // agent drives.
  const report = useCallback(() => {
    const element = page.current
    if (!element || !sheet.current || !sessionId) return
    const rect = element.getBoundingClientRect()
    const radius = parseFloat(getComputedStyle(sheet.current).borderBottomLeftRadius) || 0
    void window.kettu.browser.setBounds(sessionId, {
      x: Math.round(rect.left * zoom),
      y: Math.round(rect.top * zoom),
      width: Math.round(rect.width * zoom),
      height: Math.round(rect.height * zoom),
      radius: Math.round(radius * zoom),
    })
  }, [sessionId, zoom])

  // A notice, the driving bar or the progress bar moves the page's area without resizing it.
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
      void window.kettu.browser.thaw(sessionId).finally(() => {
        useBrowserStore.getState().setStill(sessionId, null)
      })
      return
    }
    let cancelled = false
    const frame = requestAnimationFrame(() => {
      const area = page.current
      if (!area || !covers(area)) return
      void window.kettu.browser
        .freeze(sessionId)
        .then((image) => {
          // The overlay may have closed while the page was captured; then nothing is shown.
          if (!image) return
          if (cancelled) void window.kettu.browser.thaw(sessionId)
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
      void window.kettu.browser.thaw(sessionId)
      useBrowserStore.getState().setStill(sessionId, null)
    }
  }, [sessionId])

  const hasPage = !!state?.url
  const driving = state?.control.kind === 'agent'
  const userControl = state?.control.kind === 'user'

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
          cornered && 'pl-[calc(36px+var(--traffic-lights))]',
        )}
      >
        {cornered && <CornerControls className="mr-1" />}
        <div className="app-region-no-drag flex min-w-0 items-center gap-0.5">
          <PanelButton
            label={t('actions.back')}
            shortcut={isMac ? '⌘[' : 'Ctrl+['}
            disabled={!state?.canGoBack}
            onClick={() => sessionId && void window.kettu.browser.back(sessionId)}
          >
            <ArrowLeftIcon className="size-3.5" />
          </PanelButton>
          <PanelButton
            label={t('actions.forward')}
            shortcut={isMac ? '⌘]' : 'Ctrl+]'}
            disabled={!state?.canGoForward}
            onClick={() => sessionId && void window.kettu.browser.forward(sessionId)}
          >
            <ArrowRightIcon className="size-3.5" />
          </PanelButton>
          {state?.loading ? (
            <PanelButton
              label={t('actions.stop')}
              onClick={() => sessionId && void window.kettu.browser.stop(sessionId)}
            >
              <XIcon className="size-3.5" />
            </PanelButton>
          ) : (
            <PanelButton
              label={t('actions.reload')}
              shortcut={isMac ? '⌘R' : 'Ctrl+R'}
              disabled={!hasPage}
              onClick={() => sessionId && void window.kettu.browser.reload(sessionId)}
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
            onClick={() => sessionId && void window.kettu.browser.openExternal(sessionId)}
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
      {(driving || userControl) && (
        <DrivingBar
          agent={agentId ?? null}
          user={userControl}
          onStop={() => sessionId && void window.kettu.browser.stopDriving(sessionId)}
          onHandBack={() => sessionId && void window.kettu.browser.handBack(sessionId)}
        />
      )}
      {sessionId && state?.originRequest && (
        <OriginBar
          request={state.originRequest}
          agentName={agentId ? agentName(agentId) : ''}
          onAnswer={(decision) =>
            void window.kettu.browser.answerOrigin(sessionId, state.originRequest!.id, decision)
          }
        />
      )}
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
      {/* The 2 px info frame sits around the page, not over it: a native view covers its own area. */}
      <div
        ref={page}
        className={cn('relative min-h-0 flex-1', driving ? 'bg-info p-0.5' : 'bg-background')}
      >
        <div className="relative h-full w-full bg-background">
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
    </div>
  )
}

/** A blocked download, a page lost to make room, or a page that did not load. */
function Notice({ notice, sessionId }: { notice: BrowserNotice; sessionId: string | null }) {
  const { t } = useTranslation('browser')
  const open = () => {
    if (sessionId) void window.kettu.browser.openExternal(sessionId)
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
          onClick={() => void window.kettu.browser.reload(sessionId)}
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
