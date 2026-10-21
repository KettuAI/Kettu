import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { useDefaultLayout, usePanelRef } from 'react-resizable-panels'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@renderer/components/ui/resizable'
import { SidebarProvider } from '@renderer/components/ui/sidebar'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import { HostBanner } from '@renderer/features/shell/host-banner'
import { MainArea } from '@renderer/features/shell/main-area'
import { QuitConfirm } from '@renderer/features/updates/quit-confirm'
import { AppSidebar } from '@renderer/features/sidebar/app-sidebar'
import { layoutStorage, readJson, writeJson } from '@renderer/lib/storage'
import { cn } from '@renderer/lib/utils'
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

  useEffect(() => {
    const panel = sidebar.current
    if (!panel) return
    if (collapsed && !panel.isCollapsed()) panel.collapse()
    if (!collapsed && panel.isCollapsed()) {
      panel.expand()
      // Started collapsed, the panel has no size to return to, so it takes the one saved on collapse.
      const saved = readJson(SIDEBAR_WIDTH, 0)
      if (saved > panel.getSize().inPixels) panel.resize(saved)
    }
  }, [collapsed, sidebar])

  return (
    <ResizablePanelGroup
      orientation="horizontal"
      defaultLayout={layout.defaultLayout}
      onLayoutChanged={layout.onLayoutChanged}
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
        className="min-w-0"
      >
        <AppSidebar />
      </ResizablePanel>
      {/* Collapsed, the handle takes no width, so nothing shows at the window's edge. */}
      <ResizableHandle className={cn(collapsed && 'pointer-events-none w-0')} />
      <ResizablePanel id="main" minSize="560px" className="min-w-0 bg-background">
        <MainArea />
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}

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
