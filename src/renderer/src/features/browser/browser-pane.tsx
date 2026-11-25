import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  Globe02Icon,
  LinkSquare02Icon,
  ReloadIcon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { fitViewport, type BrowserNotice, type BrowserViewport } from '@shared/browser'
import { onAppEvent } from '@renderer/app/events'
import { useControlAgent } from '@renderer/components/control/use-control-agent'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { PaneBody, PaneEmpty, PaneIcon, PanelButton } from '@renderer/features/shell/panel-button'
import { hostOfPath } from '@renderer/lib/host-paths'
import { isMac } from '@renderer/lib/platform'
import { agentName } from '@renderer/stores/agents'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useBrowserStore } from '@renderer/stores/browser'
import { useOpenOverlays } from '@renderer/stores/overlays'
import { useSettingsStore } from '@renderer/stores/settings'
import { panelSession } from '@renderer/stores/view'
import { AddressField } from './address-field'
import { OriginBar } from './origin-bar'
import { BringSignInsOffer, SignInChip } from './sign-in-offer'

/**
 * What a page's tab shows in the side panel: the context bar with its navigation and address,
 * and the selected tab's page, drawn by main over the page area.
 */
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
  const agent = useControlAgent(agentId, hostId)
  const overlays = useOpenOverlays()
  const zoom = useSettingsStore((s) => s.settings.appearance.zoom)
  // The frame the page fills.
  const page = useRef<HTMLDivElement>(null)
  const address = useRef<HTMLInputElement>(null)
  // The session the pane shows, so a capture that lands after the pane left it is dropped.
  const live = useRef<string | null>(null)
  const name = agentId ? agentName(agentId, hostId) : t('empty.agent')

  // The pane shows the page, so the toggle's dot has done its work.
  useEffect(() => {
    if (sessionId) useBrowserStore.getState().seen(sessionId)
  }, [sessionId, hidden])

  const newTab = useCallback(() => {
    if (!sessionId) return
    void window.kettu.browser
      .newTab(sessionId)
      .catch((error: unknown) => console.error('Could not open a tab', error))
  }, [sessionId])

  // Mod+T opens a tab; Mod+L in the page goes to its address. Mod+W is the row's.
  useEffect(
    () =>
      onAppEvent((event) => {
        if (event.kind === 'focus-browser-address') {
          if (event.sessionId === sessionId) address.current?.focus()
        } else if (event.kind === 'new-browser-tab') newTab()
      }),
    [newTab, sessionId],
  )

  const navigate = (url: string) => {
    if (sessionId) void window.kettu.browser.navigate(sessionId, url)
  }

  // Main shows the session's page while the pane is open, and keeps it while the pane is hidden;
  // the pill on the page names the session's agent.
  useEffect(() => {
    if (!sessionId) return
    void window.kettu.browser.show(sessionId, agent)
    return () => {
      void window.kettu.browser.hide(sessionId)
    }
  }, [sessionId, agent])

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
  // renderer cannot draw over. The check runs whenever any overlay opens or closes, since one that
  // covers the page can open while another is already open, and again when the pane maximizes or
  // restores under a toast that stays up.
  useEffect(() => {
    if (!sessionId) return
    const thaw = () => {
      if (!useBrowserStore.getState().stills[sessionId]) return
      void window.kettu.browser.thaw(sessionId).finally(() => {
        useBrowserStore.getState().setStill(sessionId, null)
      })
    }
    if (Object.keys(overlays).length === 0) {
      thaw()
      return
    }
    const frame = requestAnimationFrame(() => {
      const area = page.current
      if (!area || !covers(area)) {
        thaw()
        return
      }
      void window.kettu.browser
        .freeze(sessionId)
        .then((image) => {
          if (!image) return
          // Overlays may open and close while the page is captured, and a later check finds the
          // page already frozen, so whether to keep the still is decided by what covers it now.
          const now = page.current
          if (live.current === sessionId && now && covers(now)) {
            useBrowserStore.getState().setStill(sessionId, image)
          } else {
            void window.kettu.browser.thaw(sessionId).finally(() => {
              useBrowserStore.getState().setStill(sessionId, null)
            })
          }
        })
        .catch(() => {})
    })
    return () => cancelAnimationFrame(frame)
  }, [overlays, sessionId, maximized])

  // Leaving the pane or its session drops a still that is no longer in front of anything.
  useEffect(() => {
    if (!sessionId) return
    live.current = sessionId
    return () => {
      live.current = null
      if (!useBrowserStore.getState().stills[sessionId]) return
      void window.kettu.browser.thaw(sessionId)
      useBrowserStore.getState().setStill(sessionId, null)
    }
  }, [sessionId])

  const url = state?.url ?? null

  return (
    <PaneBody data-browser-panel="">
      <div className="kp-body">
        {/* A page without an address, such as a popup still at about:blank, is on screen too. */}
        {state && (url || state.page) ? (
          <>
            <div className="kp-ctx kp-addr-row">
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
              <AddressField
                key={state.selected}
                ref={address}
                url={url}
                onNavigate={navigate}
                trailing={
                  <SignInChip
                    url={url}
                    sessionId={sessionId}
                    hidden={state.control.kind === 'agent' && state.selected === state.agentTab}
                  />
                }
              />
              <PanelButton
                label={t('actions.openExternal')}
                disabled={!url}
                onClick={() => sessionId && void window.kettu.browser.openExternal(sessionId)}
              >
                <PaneIcon icon={LinkSquare02Icon} />
              </PanelButton>
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
            <div ref={page} className="kp-view" data-fitted={state.viewport ? '' : undefined}>
              {state.viewport ? (
                <FittedPage frame={page} viewport={state.viewport} zoom={zoom} still={still} />
              ) : (
                still && <img src={still} alt="" aria-hidden className="kp-view__still" />
              )}
            </div>
          </>
        ) : (
          <>
            <PaneEmpty
              icon={<PaneIcon icon={Globe02Icon} size={20} />}
              title={sessionId ? t('empty.title') : t('empty.noSession')}
              text={sessionId ? t('empty.hint', { agent: name }) : t('empty.noSessionHint')}
            >
              {sessionId && (
                <div className="kp-addr-row kp-addr-row--empty">
                  <AddressField
                    key={state?.selected ?? ''}
                    ref={address}
                    url={null}
                    onNavigate={navigate}
                    autoFocus
                  />
                </div>
              )}
              {sessionId && <BringSignInsOffer />}
            </PaneEmpty>
            {/* Main keeps a closed page's view hidden, but still needs a place for the next one. */}
            <div ref={page} hidden />
          </>
        )}
      </div>
    </PaneBody>
  )
}

/** How much room under the page's box its size line needs, in CSS pixels. */
const SIZE_LINE_ROOM = 36

/**
 * The box of a page that keeps its own size, where main draws it scaled inside the frame, and
 * under it the size and the scale.
 */
function FittedPage({
  frame,
  viewport,
  zoom,
  still,
}: {
  frame: RefObject<HTMLDivElement | null>
  viewport: BrowserViewport
  zoom: number
  still: string | undefined
}) {
  const { t } = useTranslation('browser')
  const [box, setBox] = useState<{
    left: number
    width: number
    height: number
    percent: number
    room: number
  } | null>(null)

  useLayoutEffect(() => {
    const element = frame.current
    if (!element) return
    const measure = () => {
      const rect = element.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return
      // As main fits it, from the frame in the window's own pixels.
      const { bounds, scale } = fitViewport(
        {
          x: 0,
          y: 0,
          width: Math.round(rect.width * zoom),
          height: Math.round(rect.height * zoom),
          radius: 0,
        },
        viewport,
      )
      const next = {
        left: bounds.x / zoom,
        width: bounds.width / zoom,
        height: bounds.height / zoom,
        percent: Math.round(scale * 100),
        room: rect.height - bounds.height / zoom,
      }
      setBox((last) =>
        last &&
        last.left === next.left &&
        last.width === next.width &&
        last.height === next.height &&
        last.room === next.room
          ? last
          : next,
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [frame, viewport, zoom])

  if (!box) return null
  const size = { width: viewport.width, height: viewport.height, percent: box.percent }
  return (
    <>
      <div
        className="kp-view__page"
        style={{ left: box.left, width: box.width, height: box.height }}
      >
        {still && <img src={still} alt="" aria-hidden className="kp-view__still" />}
      </div>
      {box.room >= SIZE_LINE_ROOM && (
        <Tooltip>
          <TooltipTrigger render={<span className="kp-view__size" style={{ top: box.height }} />}>
            {box.percent < 100 ? t('viewport.scaled', size) : t('viewport.size', size)}
          </TooltipTrigger>
          <TooltipContent>{t('viewport.hint')}</TooltipContent>
        </Tooltip>
      )}
    </>
  )
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
