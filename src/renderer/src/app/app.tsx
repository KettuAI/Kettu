import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { useDefaultLayout, usePanelRef } from 'react-resizable-panels'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@renderer/components/ui/resizable'
import { SidebarProvider } from '@renderer/components/ui/sidebar'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import { ArtifactDialogs } from '@renderer/features/artifacts/artifact-dialogs'
import { HostBanner } from '@renderer/features/shell/host-banner'
import { MainArea } from '@renderer/features/shell/main-area'
import { QuitConfirm } from '@renderer/features/updates/quit-confirm'
import { AppSidebar } from '@renderer/features/sidebar/app-sidebar'
import { layoutStorage, readJson, writeJson } from '@renderer/lib/storage'
import { cn } from '@renderer/lib/utils'
import { prefersReducedMotion } from '@renderer/stores/settings'
import { useViewStore } from '@renderer/stores/view'
import { useKeyboardShortcuts } from './shortcuts'
import { useAppCommands } from './commands'

const SettingsPage = lazy(() => import('@renderer/features/settings/settings-page'))

export function App() {
  const settingsOpen = useViewStore((s) => s.settings.open)
  useKeyboardShortcuts()
  useAppCommands()

  return (
    <TooltipProvider delay={500}>
      <SidebarProvider className="h-svh min-h-0 overflow-hidden">
        <div className="relative flex h-full w-full flex-col">
          <HostBanner />
          <div className="relative min-h-0 flex-1">
            {/* The workbench stays mounted under Settings, so threads and terminals keep their
                state and scroll position; content-visibility skips rendering it meanwhile. */}
            <div
              inert={settingsOpen}
              className={cn('absolute inset-0', settingsOpen && '[content-visibility:hidden]')}
            >
              <Workbench />
            </div>
            {settingsOpen && (
              <div className="absolute inset-0">
                <Suspense fallback={null}>
                  <SettingsPage />
                </Suspense>
              </div>
            )}
          </div>
        </div>
        <QuitConfirm />
        <ArtifactDialogs />
        <ReportInteractive />
      </SidebarProvider>
    </TooltipProvider>
  )
}

// The sidebar's width when it was last collapsed, for an app that starts collapsed.
const SIDEBAR_WIDTH = 'sidebar-width'

function Workbench() {
  const collapsed = useViewStore((s) => s.sidebarCollapsed)
  // Fixed at mount: a changed default re-registers the panel, which forgets its size before collapsing.
  const [sidebarDefault] = useState(() => (collapsed ? '0px' : '260px'))
  const sidebar = usePanelRef()
  const width = useRef(0)
  const layout = useDefaultLayout({ id: 'workbench', storage: layoutStorage })
  const group = useRef<HTMLDivElement>(null)
  const sidebarContent = useRef<HTMLDivElement>(null)
  const mainContent = useRef<HTMLDivElement>(null)
  const sliding = useRef(false)

  // A toggle slides the sidebar: both panels' contents take their final widths at once, so the
  // thread lays out once, and the panels' sizes transition around them (globals.css), each
  // content held to its panel's right edge. Nothing else changes, so no subtree restyles.
  const startSlide = (sidebarWidth: number, mainWidth: number) => {
    if (sidebarContent.current) sidebarContent.current.style.width = `${sidebarWidth}px`
    if (mainContent.current) mainContent.current.style.width = `${mainWidth}px`
    if (group.current) group.current.dataset.sliding = ''
    sliding.current = true
  }
  const endSlide = () => {
    sliding.current = false
    if (sidebarContent.current) sidebarContent.current.style.width = ''
    if (mainContent.current) mainContent.current.style.width = ''
    if (group.current) delete group.current.dataset.sliding
  }

  useEffect(() => {
    const panel = sidebar.current
    if (!panel) return
    const from = panel.getSize().inPixels
    // A drag past the minimum collapses the panel itself and lands here with nothing to do.
    if (collapsed && !panel.isCollapsed()) panel.collapse()
    else if (!collapsed && panel.isCollapsed()) {
      panel.expand()
      // Started collapsed, the panel has no size to return to, so it takes the one saved on collapse.
      const saved = readJson(SIDEBAR_WIDTH, 0)
      if (saved > panel.getSize().inPixels) panel.resize(saved)
    } else return
    const element = group.current
    if (prefersReducedMotion() || !element) return
    // Sizes read now are the ones before the change, which reaches the panels on the next render,
    // so the open width is the one before collapsing, or the one saved then.
    const open = collapsed ? from : readJson(SIDEBAR_WIDTH, 0)
    if (open <= 0) return
    // The handle already has its final width, none while collapsed.
    const handle = element.querySelector(':scope > [data-slot=resizable-handle]')
    const mainWidth =
      element.getBoundingClientRect().width -
      (collapsed ? 0 : open) -
      (handle?.getBoundingClientRect().width ?? 0)
    // The panels report their sizes on every frame of the slide, so its end is recorded here.
    if (collapsed) writeJson(SIDEBAR_WIDTH, from)
    width.current = collapsed ? 0 : open
    startSlide(open, mainWidth)
  }, [collapsed, sidebar])

  return (
    <ResizablePanelGroup
      elementRef={group}
      orientation="horizontal"
      defaultLayout={layout.defaultLayout}
      onLayoutChanged={layout.onLayoutChanged}
      onTransitionEnd={(event) => {
        const panel = event.target as HTMLElement
        if (event.propertyName === 'flex-grow' && panel.parentElement === event.currentTarget) {
          endSlide()
        }
      }}
      className="bg-sidebar"
    >
      <ResizablePanel
        id="sidebar"
        panelRef={sidebar}
        defaultSize={sidebarDefault}
        minSize="200px"
        maxSize="400px"
        collapsible
        collapsedSize="0px"
        groupResizeBehavior="preserve-pixel-size"
        onResize={(size) => {
          if (sliding.current) return
          const isCollapsed = size.inPixels === 0
          if (!isCollapsed) width.current = size.inPixels
          else if (width.current > 0) {
            writeJson(SIDEBAR_WIDTH, width.current)
            width.current = 0
          }
          if (isCollapsed !== useViewStore.getState().sidebarCollapsed) {
            useViewStore.setState({ sidebarCollapsed: isCollapsed })
          }
        }}
        className={SLIDING_PANEL}
      >
        <div ref={sidebarContent} className={PANEL_CONTENT}>
          <AppSidebar />
        </div>
      </ResizablePanel>
      {/* The sidebar's edge, as the reference's soft hairline. Collapsed, the handle takes no
          width, so nothing shows at the window's edge. */}
      <ResizableHandle
        className={cn('bg-border-soft', collapsed && 'pointer-events-none w-0')}
        onPointerDown={() => sliding.current && endSlide()}
      />
      <ResizablePanel id="main" minSize="560px" className={cn(SLIDING_PANEL, 'bg-background')}>
        <div ref={mainContent} className={PANEL_CONTENT}>
          <MainArea />
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}

// A panel holds its content against its right edge, where a content wider than the panel, as
// while the sidebar slides, is cut off on the left. Flex all along: switching display would
// rebuild the subtree's layout objects.
const SLIDING_PANEL = 'flex min-w-0 justify-end'
const PANEL_CONTENT = 'h-full w-full min-w-0 shrink-0'

/** Tells main when the first frame of the shell is on screen, for the launch budget. */
function ReportInteractive() {
  const sent = useRef(false)
  useEffect(() => {
    if (sent.current) return
    sent.current = true
    requestAnimationFrame(() =>
      requestAnimationFrame(() => window.overbench.app.reportInteractive()),
    )
  }, [])
  return null
}
