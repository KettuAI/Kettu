import { useEffect, useRef, type ReactNode } from 'react'
import { useDefaultLayout } from 'react-resizable-panels'
import { onAppEvent } from '@renderer/app/events'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@renderer/components/ui/resizable'
import { SidePanelContext } from '@renderer/features/shell/side-panel'
import { layoutStorage } from '@renderer/lib/storage'
import { cn } from '@renderer/lib/utils'
import {
  createTerminal,
  loadTerminals,
  terminalsOf,
  useTerminalsStore,
} from '@renderer/stores/terminals'
import { toggleTerminal, useViewStore } from '@renderer/stores/view'
import { TerminalPanel } from './terminal-panel'

/**
 * The main area with the project's terminal in the side panel on its right. Opening or closing it
 * changes the content's width at once. Maximized, the panel covers the whole area while the layout
 * underneath keeps its sizes, so restoring returns to exactly the widths before.
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
  const layout = useDefaultLayout({
    id: 'side-panel',
    panelIds: open ? ['content', 'side-panel'] : ['content'],
    storage: layoutStorage,
    onlySaveAfterUserInteractions: true,
  })
  const previous = useRef({ projectPath, open })

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
    <SidePanelContext value={open}>
      <ResizablePanelGroup
        orientation="horizontal"
        defaultLayout={layout.defaultLayout}
        onLayoutChanged={layout.onLayoutChanged}
        className="relative"
      >
        <ResizablePanel id="content" minSize="360px" className="min-w-0">
          {/* Under the maximized panel the content keeps its state but is not rendered. */}
          <div
            inert={maximized}
            className={cn('h-full', maximized && '[content-visibility:hidden]')}
          >
            {children}
          </div>
        </ResizablePanel>
        {open && (
          <>
            <ResizableHandle className={maximized ? 'pointer-events-none' : undefined} />
            <ResizablePanel
              id="side-panel"
              defaultSize="340px"
              minSize="280px"
              groupResizeBehavior="preserve-pixel-size"
              className="min-w-0"
            >
              <TerminalPanel projectPath={projectPath} maximized={maximized} />
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
    </SidePanelContext>
  )
}
