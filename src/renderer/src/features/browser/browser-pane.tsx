import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  Globe02Icon,
  LinkSquare02Icon,
  ReloadIcon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { BrowserNotice } from '@shared/browser'
import { onAppEvent } from '@renderer/app/events'
import {
  PaneEmpty,
  PaneHead,
  PaneIcon,
  PaneSheet,
  PaneTabClose,
  PanelButton,
} from '@renderer/features/shell/panel-button'
import { hostOfPath } from '@renderer/lib/host-paths'
import { isMac } from '@renderer/lib/platform'
import { agentName } from '@renderer/stores/agents'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useBrowserStore } from '@renderer/stores/browser'
import { useOverlayOpen } from '@renderer/stores/overlays'
import { useSettingsStore } from '@renderer/stores/settings'
import { loadSiteIcons, useSiteIcon } from '@renderer/stores/site-icons'
import { panelSession, toggleSidePane } from '@renderer/stores/view'
import { addressText } from './address'
import { AddressField } from './address-field'
import { DrivingPill } from './driving-bar'
import { OriginBar } from './origin-bar'

/** The side panel's Browser pane: one page per session, drawn by main over the pane's page area. */
export function BrowserPane({ panel, maximized }: { panel: string; maximized: boolean }) {
  const { t } = useTranslation(['browser', 'common'])
  const sessionId = panelSession(panel)
  const state = useBrowserStore((s) => (sessionId ? s.bySession[sessionId] : undefined))
  const still = useBrowserStore((s) => (sessionId ? s.stills[sessionId] : undefined))
  const hidden = useBrowserStore((s) => (sessionId ? !!s.unseen[sessionId] : false))
  const agentId = useSessionsStore((s) => (sessionId ? s.byId[sessionId]?.agentId : null)) ?? null
  const hostId = useSessionsStore((s) =>
    sessionId ? hostOfPath(s.byId[sessionId]?.projectPath ?? '') : null,
  )
  const overlayOpen = useOverlayOpen()
  const zoom = useSettingsStore((s) => s.settings.appearance.zoom)
  // The frame the page fills.
  const page = useRef<HTMLDivElement>(null)

  // The pane shows the page, so the toggle's dot has done its work.
  useEffect(() => {
    if (sessionId) useBrowserStore.getState().seen(sessionId)
  }, [sessionId, hidden])

  const closePage = useCallback(() => {
    if (!sessionId) return
    void window.kettu.browser
      .close(sessionId)
      .catch((error: unknown) => console.error('Could not close the page', error))
  }, [sessionId])

  // Mod+W destroys the page and folds the pane away.
  useEffect(
    () =>
      onAppEvent((event) => {
        if (event.kind !== 'close-browser') return
        closePage()
        toggleSidePane(panel, 'browser', false)
      }),
    [closePage, panel],
  )

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

  // The page's frame, in the window's own pixels: the renderer's zoom scales CSS pixels. Main
  // rounds the page's corners as the frame's are, since nothing in the renderer can clip a view.
  const report = useCallback(() => {
    const element = page.current
    if (!element || !sessionId) return
    const rect = element.getBoundingClientRect()
    // With no page there is no frame; the page keeps the last one until it comes back.
    if (rect.width === 0 || rect.height === 0) return
    const radius = parseFloat(getComputedStyle(element).borderBottomLeftRadius) || 0
    void window.kettu.browser.setBounds(sessionId, {
      x: Math.round(rect.left * zoom),
      y: Math.round(rect.top * zoom),
      width: Math.round(rect.width * zoom),
      height: Math.round(rect.height * zoom),
      radius: Math.round(radius * zoom),
    })
  }, [sessionId, zoom])

  // A notice, the address row or the origin card moves the page's frame without resizing it.
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

  const url = state?.url ?? null
  const driving = state?.control.kind === 'agent'
  // The user keeps control after Hand back's 10 s; only the pill goes until the next call.
  const userControl = state?.control.kind === 'user' && state.control.bar

  return (
    <PaneSheet pane="browser" maximized={maximized} data-browser-panel="">
      <PaneHead
        panel={panel}
        pane="browser"
        maximized={maximized}
        tools={
          <PanelButton
            label={t('actions.openExternal')}
            disabled={!url}
            onClick={() => sessionId && void window.kettu.browser.openExternal(sessionId)}
          >
            <PaneIcon icon={LinkSquare02Icon} />
          </PanelButton>
        }
      >
        {url && state ? (
          <div role="tablist" aria-label={t('tabs')} className="kp-head__tabs">
            <span className="kp-tab" data-selected="">
              <span role="tab" aria-selected title={url} className="kp-tab__btn">
                <SiteMark url={url} />
                <span className="kp-tab__name">{state.title || addressText(url) || url}</span>
              </span>
              <PaneTabClose label={t('actions.closePage')} onClick={closePage} />
            </span>
          </div>
        ) : (
          <span className="kp-head__title">{t('title')}</span>
        )}
      </PaneHead>
      <div className="kp-body">
        {url && state ? (
          <>
            <div className="kp-addr-row">
              <PanelButton
                label={t('actions.back')}
                shortcut={isMac ? '⌘[' : 'Ctrl+['}
                disabled={!state.canGoBack}
                onClick={() => sessionId && void window.kettu.browser.back(sessionId)}
              >
                <PaneIcon icon={ArrowLeft01Icon} />
              </PanelButton>
              <PanelButton
                label={t('actions.forward')}
                shortcut={isMac ? '⌘]' : 'Ctrl+]'}
                disabled={!state.canGoForward}
                onClick={() => sessionId && void window.kettu.browser.forward(sessionId)}
              >
                <PaneIcon icon={ArrowRight01Icon} />
              </PanelButton>
              {state.loading ? (
                <PanelButton
                  label={t('actions.stop')}
                  onClick={() => sessionId && void window.kettu.browser.stop(sessionId)}
                >
                  <PaneIcon icon={Cancel01Icon} />
                </PanelButton>
              ) : (
                <PanelButton
                  label={t('actions.reload')}
                  shortcut={isMac ? '⌘R' : 'Ctrl+R'}
                  onClick={() => sessionId && void window.kettu.browser.reload(sessionId)}
                >
                  <PaneIcon icon={ReloadIcon} />
                </PanelButton>
              )}
              <AddressField url={url} onNavigate={navigate} />
              {/* Main draws the page over its frame, so the pill sits beside the address. */}
              {(driving || userControl) && (
                <DrivingPill
                  agent={agentId}
                  hostId={hostId}
                  user={userControl}
                  onTakeOver={() => sessionId && void window.kettu.browser.stopDriving(sessionId)}
                  onHandBack={() => sessionId && void window.kettu.browser.handBack(sessionId)}
                />
              )}
              {state.loading && (
                <span role="progressbar" aria-label={t('loading')} className="kp-load" />
              )}
            </div>
            {sessionId && state.originRequest && (
              <OriginBar
                request={state.originRequest}
                agent={agentId}
                hostId={hostId}
                agentName={agentId ? agentName(agentId, hostId) : ''}
                onAnswer={(decision) =>
                  void window.kettu.browser.answerOrigin(
                    sessionId,
                    state.originRequest!.id,
                    decision,
                  )
                }
              />
            )}
            {state.notice && <Notice notice={state.notice} sessionId={sessionId} />}
            <div ref={page} className="kp-view" data-driver={driving ? 'agent' : undefined}>
              {still && <img src={still} alt="" aria-hidden className="kp-view__still" />}
            </div>
          </>
        ) : (
          <>
            <PaneEmpty
              icon={<PaneIcon icon={Globe02Icon} size={20} />}
              title={sessionId ? t('empty.title') : t('empty.noSession')}
              text={
                sessionId
                  ? t('empty.hint', {
                      agent: agentId ? agentName(agentId, hostId) : t('empty.agent'),
                    })
                  : t('empty.noSessionHint')
              }
            >
              {sessionId && (
                <div className="kp-addr-row kp-addr-row--empty">
                  <AddressField url={null} onNavigate={navigate} autoFocus />
                </div>
              )}
            </PaneEmpty>
            {/* Main keeps a closed page's view hidden, but still needs a place for the next one. */}
            <div ref={page} hidden />
          </>
        )}
      </div>
    </PaneSheet>
  )
}

/** The page's site icon, as recorded when it opened, else a globe. */
function SiteMark({ url }: { url: string }) {
  useEffect(loadSiteIcons, [])
  const icon = useSiteIcon(url)
  if (icon) return <img src={icon} alt="" aria-hidden className="kp-sitemark" />
  return <PaneIcon icon={Globe02Icon} size={14} className="kp-tab__icon" />
}

/** A blocked download, a page lost to make room, or a page that did not load, crashed or hangs. */
function Notice({ notice, sessionId }: { notice: BrowserNotice; sessionId: string | null }) {
  const { t } = useTranslation('browser')
  const open = () => {
    if (sessionId) void window.kettu.browser.openExternal(sessionId)
  }
  return (
    <div role="status" className="kp-origin" data-answered="" data-denied="">
      <span className="kp-origin__text">
        <span className="truncate">
          {notice.kind === 'download-blocked' && t('notice.downloadBlocked')}
          {notice.kind === 'evicted' && t('notice.evicted')}
          {notice.kind === 'load-failed' && t('notice.loadFailed', { error: notice.description })}
          {notice.kind === 'crashed' && t('notice.crashed')}
          {notice.kind === 'unresponsive' && t('notice.unresponsive')}
        </span>
      </span>
      {notice.kind === 'download-blocked' && (
        <button type="button" onClick={open} className="kp-link">
          {t('actions.openExternal')}
        </button>
      )}
      {notice.kind !== 'download-blocked' && sessionId && (
        <button
          type="button"
          onClick={() => void window.kettu.browser.reload(sessionId)}
          className="kp-link"
        >
          {notice.kind === 'load-failed' ? t('actions.tryAgain') : t('actions.reload')}
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
