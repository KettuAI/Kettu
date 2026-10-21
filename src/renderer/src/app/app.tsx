import { lazy, Suspense, useEffect, useRef } from 'react'
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
import { layoutStorage } from '@renderer/lib/storage'
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

function Workbench() {
  const collapsed = useViewStore((s) => s.sidebarCollapsed)
  const sidebar = usePanelRef()
  const layout = useDefaultLayout({ id: 'workbench', storage: layoutStorage })

  useEffect(() => {
    const panel = sidebar.current
    if (!panel) return
    if (collapsed && !panel.isCollapsed()) panel.collapse()
    if (!collapsed && panel.isCollapsed()) panel.expand()
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
        defaultSize={collapsed ? '0px' : '260px'}
        minSize="200px"
        maxSize="400px"
        collapsible
        collapsedSize="0px"
        groupResizeBehavior="preserve-pixel-size"
        onResize={(size) => {
          const isCollapsed = size.inPixels === 0
          if (isCollapsed !== useViewStore.getState().sidebarCollapsed) {
            useViewStore.setState({ sidebarCollapsed: isCollapsed })
          }
        }}
        className="min-w-0"
      >
        <AppSidebar />
      </ResizablePanel>
      <ResizableHandle className={cn(collapsed && 'pointer-events-none')} />
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
