import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AnimatePresence } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { AppShell } from '@renderer/components/affect/app-shell'
import { Toaster } from '@renderer/components/ui/toast'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import { ArtifactDialogs } from '@renderer/features/artifacts/artifact-dialogs'
import { AutoPublishNotice } from '@renderer/features/artifacts/auto-publish-notice'
import { ArtifactConsentDialog } from '@renderer/features/artifacts/consent-dialog'
import { GitDialogsHost } from '@renderer/features/git/git-dialogs'
import { MediaViewer } from '@renderer/features/session/media/media-viewer'
import { HostBanner } from '@renderer/features/shell/host-banner'
import { LaunchCover } from '@renderer/features/shell/launch-cover'
import { SplitDragProvider } from '@renderer/features/split/session-drag'
import { MainArea } from '@renderer/features/shell/main-area'
import { ShortcutsDialog } from '@renderer/features/shell/shortcuts-dialog'
import { DebugRestartDialog } from '@renderer/features/shell/debug-mode'
import { CornerControls, CornerDragHole, TitleBand } from '@renderer/features/shell/top-bar'
import { QuitConfirm } from '@renderer/features/updates/quit-confirm'
import { UpdateDialog } from '@renderer/features/updates/update-dialog'
import { useAccountShell } from '@renderer/features/account/account-row'
import { SidebarList, SidebarNotices } from '@renderer/features/sidebar/app-sidebar'
import { useSidebarNav } from '@renderer/features/sidebar/sidebar-nav'
import { ArchiveConfirmDialog } from '@renderer/features/sidebar/archive-confirm'
import { RemoveWorktreeDialog } from '@renderer/features/worktrees/remove-worktree-dialog'
import { WorktreeSettingsDialog } from '@renderer/features/worktrees/worktree-settings-dialog'
import { SearchDialog } from '@renderer/features/search/search-dialog'
import { ReportDialog } from '@renderer/features/report/report-dialog'
import { DiscoveryRequestDialog } from '@renderer/features/settings/discovery-request'
import { useReportNotices } from '@renderer/features/report/report-notices'
import { formatShortcut, hasBand, isWeb } from '@renderer/lib/platform'
import { readJson, writeJson } from '@renderer/lib/storage'
import { cn } from '@renderer/lib/utils'
import { prefersReducedMotion, useSettingsStore } from '@renderer/stores/settings'
import { showSearch, useViewStore } from '@renderer/stores/view'
import { usePathRequest } from '@renderer/web/host-path-request'
import { useKeyboardShortcuts } from './shortcuts'
import { useActionLog, useAppCommands } from './commands'

const SettingsPage = lazy(() => import('@renderer/features/settings/settings-page'))
// The picker for a folder or a program on a host reached over the channel, in place of a system
// dialog; loaded once first asked for.
const HostPathDialog = lazy(() => import('@renderer/web/host-path-dialog'))
// The first run on a fresh install, over the whole window until it is done.
const Onboarding = lazy(() => import('@renderer/features/onboarding/onboarding'))

export function App() {
  const settingsOpen = useViewStore((s) => s.settings.open)
  // A browser shows another computer's host, whose own app ran its onboarding.
  const onboarding = useSettingsStore((s) => !isWeb && s.loaded && !s.settings.onboarding.done)
  const cloud = useSettingsStore((s) => s.settings.cloud.enabled)
  // The window grows in under the onboarding as it leaves; a launch past it shows it at rest.
  const [arriving, setArriving] = useState(false)
  const [wasOnboarding, setWasOnboarding] = useState(onboarding)
  if (wasOnboarding !== onboarding) {
    setWasOnboarding(onboarding)
    if (!onboarding && !prefersReducedMotion()) setArriving(true)
  }
  // Settings stays mounted once loaded, so it closes with its own exit.
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  if (settingsOpen && !settingsLoaded) setSettingsLoaded(true)
  const pathAsked = usePathRequest((s) => s.asked !== null)
  const [pathPicker, setPathPicker] = useState(false)
  if (pathAsked && !pathPicker) setPathPicker(true)
  useKeyboardShortcuts()
  useAppCommands()
  useActionLog()
  useReportNotices()

  return (
    <TooltipProvider delay={500}>
      <div className="h-svh min-h-0 overflow-hidden">
        <div className="relative flex h-full w-full flex-col">
          <HostBanner />
          <div className="relative min-h-0 flex-1">
            {/* The workbench stays in view under Settings, which opens over it. */}
            <div
              inert={settingsOpen || onboarding}
              data-arriving={arriving ? '' : undefined}
              // The main area is the last to settle.
              onAnimationEnd={(event) => {
                if (event.animationName === 'kettu-arrive-main') setArriving(false)
              }}
              className="absolute inset-0"
            >
              {/* One drag scope for the sidebar and the main area: a session's row drags into
                  the split. */}
              <SplitDragProvider>
                <Workbench />
              </SplitDragProvider>
            </div>
            {settingsLoaded && (
              <Suspense fallback={null}>
                <SettingsPage />
              </Suspense>
            )}
          </div>
        </div>
        <AnimatePresence>
          {onboarding && (
            <Suspense key="onboarding" fallback={null}>
              <Onboarding />
            </Suspense>
          )}
        </AnimatePresence>
        <LaunchCover />
        <QuitConfirm />
        <UpdateDialog />
        <DebugRestartDialog />
        <ArtifactDialogs />
        <ArtifactConsentDialog />
        {cloud && <AutoPublishNotice />}
        <MediaViewer />
        <ShortcutsDialog />
        <SearchDialog />
        <ArchiveConfirmDialog />
        <RemoveWorktreeDialog />
        <WorktreeSettingsDialog />
        <ReportDialog />
        {/* Devices of the account ask the host's own windows; a browser is never asked. */}
        {!isWeb && cloud && <DiscoveryRequestDialog />}
        {pathPicker && (
          <Suspense fallback={null}>
            <HostPathDialog />
          </Suspense>
        )}
        <GitDialogsHost />
        <Toaster />
      </div>
    </TooltipProvider>
  )
}

// The sidebar's width as last set, kept across launches.
const SIDEBAR_WIDTH = 'sidebar-width'

/**
 * The window: App Shell's frame with Kettu's sidebar, the corner's toggle, Back and Forward, and
 * the main area's sheets on the desk.
 */
function Workbench() {
  const { t } = useTranslation('sidebar')
  const collapsed = useViewStore((s) => s.sidebarCollapsed)
  const drawer = useViewStore((s) => s.sidebarDrawer)
  const nav = useSidebarNav()
  const account = useAccountShell()
  const [initial] = useState(() => readJson(SIDEBAR_WIDTH, 0) || undefined)
  const save = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(save.current), [])
  // Opening a place from the drawer puts the drawer away, as App Shell's own nav does.
  useEffect(
    () =>
      useViewStore.subscribe((state, previous) => {
        if (state.sidebarDrawer && state.main !== previous.main)
          useViewStore.setState({ sidebarDrawer: false })
      }),
    [],
  )
  return (
    <div className="relative h-full">
      <TitleBand />
      <AppShell
        className={cn('kettu-frame', hasBand && 'kettu-band')}
        chrome="mac"
        lights={false}
        workspacePlacement="none"
        header={false}
        sideCards={false}
        {...nav}
        {...account}
        list={<SidebarList />}
        footCards={<SidebarNotices />}
        onSearch={() => showSearch(true)}
        collapsed={collapsed}
        onCollapsedChange={(next) => useViewStore.setState({ sidebarCollapsed: next })}
        drawer={drawer}
        onDrawerChange={(open) => useViewStore.setState({ sidebarDrawer: open })}
        sidebarWidth={{ default: 272, min: 200, max: 400, initial }}
        onSidebarWidthChange={(width) => {
          clearTimeout(save.current)
          save.current = setTimeout(() => writeJson(SIDEBAR_WIDTH, width), 300)
        }}
        corner={<CornerControls />}
        labels={{
          search: t('nav.searchField'),
          searchKey: formatShortcut('Mod+K'),
          menu: t('nav.label'),
          resize: t('nav.resize'),
          account: t('account.signedOut'),
        }}
      >
        <MainFrame />
      </AppShell>
      <CornerDragHole />
    </div>
  )
}

/**
 * The main area. A toggle slides the sidebar: the content takes its final width at once, held to
 * the right edge, so the thread lays out once while the frame's columns move around it. The frame
 * cuts the sheets to its shape and a wing of sheet fills it while it is wider than they are, so
 * the sheet's edge follows the slide.
 */
function MainFrame() {
  const collapsed = useViewStore((s) => s.sidebarCollapsed)
  const frame = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const wing = useRef<HTMLSpanElement>(null)
  const was = useRef(collapsed)

  useLayoutEffect(() => {
    if (was.current === collapsed) return
    was.current = collapsed
    const box = frame.current
    const inner = content.current
    const app = box?.closest<HTMLElement>('.ui-as-app')
    const main = box?.parentElement
    // A narrow window's sidebar is a drawer over the page, which does not move.
    if (!box || !inner || !wing.current || !app || !main || prefersReducedMotion()) return
    if (app.offsetWidth <= NARROW_FRAME) return
    const side = parseFloat(app.style.getPropertyValue('--side-w')) || 0
    const width =
      app.clientWidth - (collapsed ? 0 : side) - parseFloat(getComputedStyle(main).paddingRight)
    inner.style.width = `${width}px`
    // Over the sheets' rounded left edge, so the two meet as one sheet.
    wing.current.style.right = `${width - parseFloat(getComputedStyle(box).borderTopLeftRadius)}px`
    box.dataset.sliding = ''
    const end = () => {
      inner.style.width = ''
      wing.current?.style.removeProperty('right')
      delete box.dataset.sliding
      app.removeEventListener('transitionend', onEnd)
      clearTimeout(timer)
    }
    const onEnd = (event: TransitionEvent) => {
      if (event.target === app && event.propertyName === 'grid-template-columns') end()
    }
    app.addEventListener('transitionend', onEnd)
    // The columns' glide lasts 420 ms; a slide that never reports its end still ends.
    const timer = setTimeout(end, 700)
    return end
  }, [collapsed])

  return (
    <div ref={frame} className="kettu-slide relative flex h-full justify-end rounded-card">
      <div ref={content} className="isolate h-full w-full min-w-0 shrink-0">
        <MainArea />
      </div>
      <span ref={wing} aria-hidden className="kettu-slide__wing" />
    </div>
  )
}

// App Shell's own width for a narrow window, where the sidebar becomes a drawer.
const NARROW_FRAME = 900
