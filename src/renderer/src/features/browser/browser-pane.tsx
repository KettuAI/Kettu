import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  ComputerIcon,
  CursorRectangleSelection01Icon,
  Globe02Icon,
  LinkSquare02Icon,
  MaximizeScreenIcon,
  ReloadIcon,
  SmartPhone01Icon,
  Tablet01Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import {
  fitPageViewport,
  isAnnotatableBrowserUrl,
  PANE_PAGE_SIZE_MODES,
  PAGE_SIZES,
  SIZE_LINE_ROOM,
  type BrowserNotice,
  type BrowserViewport,
  type PageSize,
  type PanePageSizeMode,
} from '@shared/browser'
import { onAppEvent } from '@renderer/app/events'
import { useControlAgent } from '@renderer/components/control/use-control-agent'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { Kbd } from '@renderer/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { PaneBody, PaneEmpty, PaneIcon, PanelButton } from '@renderer/features/shell/panel-button'
import { hostOfPath } from '@renderer/lib/host-paths'
import { isMac } from '@renderer/lib/platform'
import { agentName } from '@renderer/stores/agents'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useBrowserStore } from '@renderer/stores/browser'
import { useOpenOverlays, useOverlayStore } from '@renderer/stores/overlays'
import { useSettingsStore } from '@renderer/stores/settings'
import { panelSession } from '@renderer/stores/view'
import { AddressField } from './address-field'
import { OriginBar } from './origin-bar'
import { covers, observeOverlayGeometry } from './overlay-cover'
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
  const hasOpenOverlays = Object.keys(overlays).length > 0
  const showsPage = !!state && !!(state.url || state.page)
  const zoom = useSettingsStore((s) => s.settings.appearance.zoom)
  // The frame the page fills.
  const page = useRef<HTMLDivElement>(null)
  const address = useRef<HTMLInputElement>(null)
  const [frameSize, setFrameSize] = useState<{ width: number; height: number } | null>(null)
  // The session the pane shows, so a capture that lands after the pane left it is dropped.
  const live = useRef<string | null>(null)
  // Tracks which session has an active or completed freeze in the current show cycle so continuous
  // geometry updates (typing in a popover, dragging a card) do not spam capturePage IPCs.
  const freezingSession = useRef<string | null>(null)
  const frozenSession = useRef<string | null>(null)
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

  // The page's frame, in the window's own pixels: the renderer's zoom scales CSS pixels. Main
  // rounds the page's corners as the frame's are, since nothing in the renderer can clip a view.
  const report = useCallback(() => {
    const element = page.current
    if (!element || !sessionId) return
    const rect = element.getBoundingClientRect()
    // With no page there is no frame; the page keeps the last one until it comes back.
    if (rect.width === 0 || rect.height === 0) return
    const radius = parseFloat(getComputedStyle(element).borderBottomLeftRadius) || 0
    const width = Math.round(rect.width * zoom)
    const height = Math.round(rect.height * zoom)
    setFrameSize((last) =>
      last && last.width === width && last.height === height ? last : { width, height },
    )
    void window.kettu.browser.setBounds(sessionId, {
      x: Math.round(rect.left * zoom),
      y: Math.round(rect.top * zoom),
      width,
      height,
      radius: Math.round(radius * zoom),
    })
  }, [sessionId, zoom])

  // An overlay that covers the page takes a still in its place: a web view is a native layer the
  // renderer cannot draw over. Whether one covers it depends on where the overlays and the page's
  // frame are, so the check runs whenever an overlay opens or closes, whenever an open overlay
  // moves or resizes, and whenever the frame moves or resizes, since any of those can bring the
  // page under an overlay that stays up.
  const coverCheck = useRef(0)
  const checkCover = useCallback(() => {
    cancelAnimationFrame(coverCheck.current)
    if (!sessionId) return
    const thaw = () => {
      if (frozenSession.current === sessionId) frozenSession.current = null
      if (!useBrowserStore.getState().stills[sessionId]) return
      void window.kettu.browser.thaw(sessionId).finally(() => {
        useBrowserStore.getState().setStill(sessionId, null)
      })
    }
    if (Object.keys(useOverlayStore.getState().open).length === 0) {
      thaw()
      return
    }
    coverCheck.current = requestAnimationFrame(() => {
      const area = page.current
      if (!area || !covers(area)) {
        thaw()
        return
      }
      if (frozenSession.current === sessionId && useBrowserStore.getState().stills[sessionId]) {
        return
      }
      if (freezingSession.current === sessionId) return
      freezingSession.current = sessionId
      void window.kettu.browser
        .freeze(sessionId)
        .then((image) => {
          if (!image) return
          // Overlays may open and close while the page is captured, and a later check finds the
          // page already frozen, so whether to keep the still is decided by what covers it now.
          const now = page.current
          if (live.current === sessionId && now && covers(now)) {
            frozenSession.current = sessionId
            useBrowserStore.getState().setStill(sessionId, image)
          } else {
            if (frozenSession.current === sessionId) frozenSession.current = null
            void window.kettu.browser.thaw(sessionId).finally(() => {
              useBrowserStore.getState().setStill(sessionId, null)
            })
          }
        })
        .catch(() => {})
        .finally(() => {
          if (freezingSession.current === sessionId) freezingSession.current = null
        })
    })
  }, [sessionId])

  // Main shows the session's page while the pane is open, and keeps it while the pane is hidden;
  // the pill on the page names the session's agent.
  useEffect(() => {
    if (!sessionId) return
    frozenSession.current = null
    freezingSession.current = null
    void window.kettu.browser.show(sessionId, agent)
    checkCover()
    return () => {
      frozenSession.current = null
      freezingSession.current = null
      void window.kettu.browser.hide(sessionId)
    }
  }, [sessionId, agent, checkCover])

  const frameChanged = useCallback(() => {
    report()
    checkCover()
  }, [report, checkCover])

  // A notice, the address row or the origin card moves the page's frame without resizing it.
  useLayoutEffect(frameChanged)

  // The frame is another element once the pane has a page.
  useLayoutEffect(() => {
    const element = page.current
    if (!element) return
    const observer = new ResizeObserver(frameChanged)
    observer.observe(element)
    window.addEventListener('resize', frameChanged)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', frameChanged)
    }
  }, [frameChanged, showsPage])

  useEffect(() => {
    checkCover()
    return () => cancelAnimationFrame(coverCheck.current)
  }, [checkCover, overlays, maximized])

  // Re-check coverage while overlays remain open and move, resize, or mount nested layers
  // (such as typing in the composer popover, moving between hovered chips, or dragging a card).
  useEffect(() => {
    if (!sessionId || !hasOpenOverlays) return
    return observeOverlayGeometry(checkCover)
  }, [sessionId, hasOpenOverlays, checkCover])

  // Leaving the pane or its session drops a still that is no longer in front of anything.
  useEffect(() => {
    if (!sessionId) return
    live.current = sessionId
    return () => {
      live.current = null
      frozenSession.current = null
      freezingSession.current = null
      if (!useBrowserStore.getState().stills[sessionId]) return
      void window.kettu.browser.thaw(sessionId)
      useBrowserStore.getState().setStill(sessionId, null)
    }
  }, [sessionId])

  const url = state?.url ?? null
  const annotating = state?.annotating === true
  const agentOwnsSelected =
    state?.control.kind === 'agent' && state.selected !== null && state.selected === state.agentTab
  const noticeBlocksAnnotate =
    state?.notice?.kind === 'load-failed' ||
    state?.notice?.kind === 'crashed' ||
    state?.notice?.kind === 'unresponsive'
  const canAnnotate =
    !!sessionId && !agentOwnsSelected && !noticeBlocksAnnotate && isAnnotatableBrowserUrl(url)
  const toggleAnnotate = useCallback(() => {
    if (!sessionId) return
    const next = !annotating
    if (next && !canAnnotate) return
    void window.kettu.browser
      .setAnnotate(sessionId, next)
      .catch((error: unknown) => console.error('Could not toggle page annotation', error))
  }, [sessionId, annotating, canAnnotate])
  const onPaneKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (annotating && sessionId && event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        void window.kettu.browser
          .setAnnotate(sessionId, false)
          .catch((error: unknown) => console.error('Could not exit page annotation', error))
      }
    },
    [annotating, sessionId],
  )
  const annotateLabel = annotating ? t('annotate.exit') : t('annotate.start')
  const annotateHint = annotating
    ? t('annotate.exit')
    : agentOwnsSelected
      ? t('annotate.disabledAgent', { agent: name })
      : !canAnnotate
        ? t('annotate.disabledNoPage')
        : t('annotate.startHint')
  const fitted =
    frameSize && state?.viewport
      ? fitPageViewport(
          { x: 0, y: 0, width: frameSize.width, height: frameSize.height, radius: 0 },
          state.viewport,
          Math.round(SIZE_LINE_ROOM * zoom),
        )
      : null
  const fittedPercent = fitted ? Math.round(fitted.scale * 100) : null
  const hasLetterbox =
    !!fitted &&
    !!frameSize &&
    (fitted.showSizeLine ||
      fitted.bounds.width < frameSize.width ||
      fitted.bounds.height < frameSize.height)

  return (
    <PaneBody data-browser-panel="" onKeyDown={onPaneKeyDown}>
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
              <AnnotateToggleButton
                label={annotateLabel}
                tooltip={annotateHint}
                active={annotating}
                disabled={!annotating && !canAnnotate}
                onToggle={toggleAnnotate}
              />
              {sessionId && (
                <PageSizeMenu
                  sessionId={sessionId}
                  viewport={state.viewport}
                  percent={fittedPercent}
                />
              )}
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
            {annotating && sessionId && (
              <div role="status" className="kp-annotate-bar" data-browser-annotate-bar="">
                <span className="kp-annotate-bar__text">
                  <PaneIcon
                    icon={CursorRectangleSelection01Icon}
                    size={14}
                    className="kp-annotate-bar__icon"
                  />
                  <span className="truncate">{t('annotate.activeHint')}</span>
                </span>
                <button
                  type="button"
                  onClick={() =>
                    void window.kettu.browser
                      .setAnnotate(sessionId, false)
                      .catch((error: unknown) =>
                        console.error('Could not exit page annotation', error),
                      )
                  }
                  className="kp-link"
                >
                  {t('annotate.done')}
                </button>
              </div>
            )}
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
            <div ref={page} className="kp-view" data-fitted={hasLetterbox ? '' : undefined}>
              {hasLetterbox && fitted && state.viewport ? (
                <FittedPage
                  bounds={fitted.bounds}
                  viewport={state.viewport}
                  percent={fittedPercent ?? 100}
                  showSizeLine={fitted.showSizeLine}
                  zoom={zoom}
                  still={still}
                />
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

const SIZE_ICONS: Record<PanePageSizeMode, typeof ComputerIcon> = {
  fit: MaximizeScreenIcon,
  desktop: ComputerIcon,
  tablet: Tablet01Icon,
  phone: SmartPhone01Icon,
}

/**
 * Toolbar toggle for element annotation mode. Wraps the disabled button in a span trigger so
 * hovering still explains why annotation is unavailable (e.g. blank page or agent control).
 */
function AnnotateToggleButton({
  label,
  tooltip,
  active,
  disabled,
  onToggle,
}: {
  label: string
  tooltip: string
  active: boolean
  disabled: boolean
  onToggle: () => void
}) {
  const button = (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onToggle}
      data-browser-annotate-toggle=""
      className="kp-tool kp-tool--annotate app-region-no-drag"
    >
      <PaneIcon icon={CursorRectangleSelection01Icon} />
    </button>
  )
  return (
    <Tooltip>
      {disabled ? (
        <TooltipTrigger render={<span className="inline-flex" />}>{button}</TooltipTrigger>
      ) : (
        <TooltipTrigger render={button} />
      )}
      <TooltipContent>
        {tooltip}
        {active && <Kbd>Esc</Kbd>}
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * The size mode of the selected tab's page: native pane fill (100%), responsive desktop width
 * (1280px wide, full pane height), or fixed device presets (tablet, phone, or custom).
 */
function PageSizeMenu({
  sessionId,
  viewport,
  percent,
}: {
  sessionId: string
  viewport: PageSize | null
  /** The rendered scale percentage of `viewport` inside the current pane frame. */
  percent: number | null
}) {
  const { t } = useTranslation('browser')
  const chosen = viewport?.name ?? 'fit'
  const label = t('viewport.menu')
  const choose = (value: unknown) => {
    if (!(PANE_PAGE_SIZE_MODES as readonly unknown[]).includes(value) || value === chosen) return
    void window.kettu.browser
      .setPageSize(sessionId, value as PanePageSizeMode)
      .catch((error: unknown) => console.error('Could not resize the page', error))
  }
  const sizeOf = (size: BrowserViewport) =>
    t('viewport.size', { width: size.width, height: size.height })
  const scaledOf = (size: BrowserViewport, pct: number | null) =>
    pct !== null && pct < 100
      ? t('viewport.scaled', { width: size.width, height: size.height, percent: pct })
      : sizeOf(size)
  const showDesktopScale = viewport?.name === 'desktop' && percent !== null && percent < 100
  const tooltipDetail = viewport ? scaledOf(viewport, percent) : t('viewport.fit')
  const noteOf = (mode: PanePageSizeMode): string => {
    if (mode === 'fit') return t('viewport.fitScale')
    if (mode === 'desktop') {
      return viewport?.name === 'desktop' ? scaledOf(viewport, percent) : t('viewport.desktopNote')
    }
    return sizeOf(PAGE_SIZES[mode])
  }
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  aria-label={label}
                  className={
                    showDesktopScale
                      ? 'kp-tool kp-size-btn app-region-no-drag'
                      : 'kp-tool app-region-no-drag'
                  }
                />
              }
            />
          }
        >
          <PaneIcon icon={chosen === 'custom' ? ComputerIcon : SIZE_ICONS[chosen]} />
          {showDesktopScale && <span>{percent}%</span>}
        </TooltipTrigger>
        <TooltipContent>
          {t('viewport.menuDetail', { label, detail: tooltipDetail })}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="min-w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{label}</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={chosen} onValueChange={choose}>
            {PANE_PAGE_SIZE_MODES.map((mode) => (
              <DropdownMenuRadioItem key={mode} value={mode}>
                <PaneIcon icon={SIZE_ICONS[mode]} size={16} />
                <span className="min-w-0 flex-1 truncate">{t(`viewport.${mode}`)}</span>
                <span className="shrink-0 text-small text-tertiary tabular-nums">
                  {noteOf(mode)}
                </span>
              </DropdownMenuRadioItem>
            ))}
            {viewport?.name === 'custom' && (
              <DropdownMenuRadioItem value="custom" disabled>
                <PaneIcon icon={ComputerIcon} size={16} />
                <span className="min-w-0 flex-1 truncate">{t('viewport.custom')}</span>
                <span className="shrink-0 text-small text-tertiary tabular-nums">
                  {sizeOf(viewport)}
                </span>
              </DropdownMenuRadioItem>
            )}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The box of a letterboxed page (a fixed device preset, or a frozen desktop page whose panel was
 * resized mid-turn), where main draws it scaled inside the frame, with its size caption underneath
 * for fixed-aspect presets.
 */
function FittedPage({
  bounds,
  viewport,
  percent,
  showSizeLine,
  zoom,
  still,
}: {
  bounds: { x: number; width: number; height: number }
  viewport: BrowserViewport
  percent: number
  showSizeLine: boolean
  zoom: number
  still: string | undefined
}) {
  const { t } = useTranslation('browser')
  const left = bounds.x / zoom
  const width = bounds.width / zoom
  const height = bounds.height / zoom
  const size = { width: viewport.width, height: viewport.height, percent }
  return (
    <>
      <div className="kp-view__page" style={{ left, width, height }}>
        {still && <img src={still} alt="" aria-hidden className="kp-view__still" />}
      </div>
      {showSizeLine && (
        <Tooltip>
          <TooltipTrigger render={<span className="kp-view__size" style={{ top: height }} />}>
            {percent < 100 ? t('viewport.scaled', size) : t('viewport.size', size)}
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
