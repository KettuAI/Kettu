import { useEffect, useRef, type ReactNode } from 'react'
import { useDefaultLayout, usePanelRef } from 'react-resizable-panels'
import { onAppEvent } from '@renderer/app/events'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@renderer/components/ui/resizable'
import { layoutStorage } from '@renderer/lib/storage'
import {
  createTerminal,
  loadTerminals,
  terminalsOf,
  useTerminalsStore,
} from '@renderer/stores/terminals'
import { toggleTerminal, useViewStore } from '@renderer/stores/view'
import { TerminalPanel } from './terminal-panel'

/**
 * The main area with the project's terminal panel under it. The panel opens and closes at once,
 * without animating its height; maximized, it takes the whole area and the thread waits hidden.
 */
export function TerminalArea({
  projectPath,
  children,
}: {
  projectPath: string
  children: ReactNode
}) {
  const open = useViewStore((s) => !!s.terminalOpen[projectPath])
  const maximized = useViewStore((s) => s.terminalMaximized) && open
  const thread = usePanelRef()
  const layout = useDefaultLayout({
    id: 'terminal',
    panelIds: open ? ['thread', 'terminal'] : ['thread'],
    storage: layoutStorage,
    onlySaveAfterUserInteractions: true,
  })
  const previous = useRef({ projectPath, open })

  useEffect(() => {
    const panel = thread.current
    if (!panel) return
    if (maximized && !panel.isCollapsed()) panel.collapse()
    if (!maximized && panel.isCollapsed()) panel.expand()
  }, [maximized, thread])

  // Opening the panel in a project without terminals starts one; switching projects never does.
  useEffect(() => {
    const before = previous.current
    previous.current = { projectPath, open }
    if (!open) return
    void loadTerminals(projectPath).then(() => {
      const opened = before.projectPath === projectPath && !before.open
      if (opened && terminalsOf(useTerminalsStore.getState().byId, projectPath).length === 0) {
        void createTerminal(projectPath)
      }
    })
  }, [projectPath, open])

  useEffect(
    () =>
      onAppEvent((event) => {
        if (event.kind === 'new-terminal') {
          toggleTerminal(projectPath, true)
          void createTerminal(projectPath)
        } else if (event.kind === 'run-in-terminal' && event.projectPath === projectPath) {
          toggleTerminal(projectPath, true)
          void createTerminal(projectPath, undefined, { text: event.command, run: false })
        } else if (event.kind === 'sign-in-terminal' && event.projectPath === projectPath) {
          toggleTerminal(projectPath, true)
          void createTerminal(projectPath, undefined, {
            text: event.command,
            run: true,
            signInAgent: event.agentId,
          })
        }
      }),
    [projectPath],
  )

  return (
    <ResizablePanelGroup
      orientation="vertical"
      defaultLayout={layout.defaultLayout}
      onLayoutChanged={layout.onLayoutChanged}
    >
      <ResizablePanel
        id="thread"
        panelRef={thread}
        minSize="160px"
        collapsible
        collapsedSize="0px"
        className="min-h-0"
      >
        {children}
      </ResizablePanel>
      {open && (
        <>
          <ResizableHandle className={maximized ? 'pointer-events-none' : undefined} />
          <ResizablePanel
            id="terminal"
            defaultSize="280px"
            minSize="120px"
            maxSize={maximized ? '100%' : '70%'}
            className="min-h-0 bg-sidebar"
          >
            <TerminalPanel projectPath={projectPath} maximized={maximized} />
          </ResizablePanel>
        </>
      )}
    </ResizablePanelGroup>
  )
}
