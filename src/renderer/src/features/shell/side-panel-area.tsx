import { lazy, Suspense, useEffect, useRef, type ReactNode } from 'react'
import { useDefaultLayout } from 'react-resizable-panels'
import { onAppEvent } from '@renderer/app/events'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@renderer/components/ui/resizable'
import { TerminalPanel } from '@renderer/features/terminal/terminal-panel'
import { layoutStorage } from '@renderer/lib/storage'
import { cn } from '@renderer/lib/utils'
import {
  createTerminal,
  loadTerminals,
  terminalsOf,
  useTerminalsStore,
} from '@renderer/stores/terminals'
import { toggleTerminal, useViewStore } from '@renderer/stores/view'
import { SHEET, SHEET_PANEL } from './sheet'

const FilesPanel = lazy(() => import('@renderer/features/files/files-panel'))
const ArtifactPane = lazy(() => import('@renderer/features/artifacts/artifact-pane'))
const BrowserPane = lazy(() =>
  import('@renderer/features/browser/browser-pane').then((module) => ({
    default: module.BrowserPane,
  })),
)

// Each pane is a panel of its own, so each keeps its width: the terminal needs less room than a
// file beside its tree. The terminal keeps the id it had when it was the only pane.
const PANES = {
  terminal: { id: 'side-panel', defaultSize: '340px', minSize: '280px' },
  files: { id: 'side-panel-files', defaultSize: '560px', minSize: '360px' },
  artifact: { id: 'side-panel-artifact', defaultSize: '560px', minSize: '360px' },
  browser: { id: 'side-panel-browser', defaultSize: '560px', minSize: '360px' },
} as const

/**
 * The main area with the project's side panel on its right, holding the terminal, the files or,
 * opened from the thread, an artifact.
 * Opening or closing it changes the content's width at once. Maximized, the panel covers the
 * whole area while the layout underneath keeps its sizes, so restoring returns to exactly the
 * widths before.
 */
export function SidePanelArea({
  projectPath,
  children,
}: {
  projectPath: string
  children: ReactNode
}) {
  const pane = useViewStore((s) => s.sidePane[projectPath])
  const artifact = useViewStore((s) => s.sideArtifact[projectPath])
  const maximized = useViewStore((s) => s.sidePaneMaximized) && !!pane
  const open = pane === 'terminal'
  const layout = useDefaultLayout({
    id: 'side-panel',
    panelIds: pane ? ['content', PANES[pane].id] : ['content'],
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
    <ResizablePanelGroup
      orientation="horizontal"
      defaultLayout={layout.defaultLayout}
      onLayoutChanged={layout.onLayoutChanged}
      className="relative"
    >
      <ResizablePanel id="content" minSize="360px" className="min-w-0" style={SHEET_PANEL}>
        {/* Under the maximized panel the content keeps its state but is not rendered, and its
            sheet's edge gives way to the panel's. */}
        <div
          inert={maximized}
          className={cn('h-full', SHEET, maximized && 'shadow-none [content-visibility:hidden]')}
        >
          {children}
        </div>
      </ResizablePanel>
      {pane && (
        <>
          {/* The desk between the two sheets. */}
          <ResizableHandle
            withHandle={!maximized}
            className={cn('app-region-no-drag w-(--sheet-gap)', maximized && 'pointer-events-none')}
          />
          <ResizablePanel
            key={pane}
            {...PANES[pane]}
            groupResizeBehavior="preserve-pixel-size"
            className="min-w-0"
            style={SHEET_PANEL}
          >
            {pane === 'terminal' ? (
              <TerminalPanel projectPath={projectPath} maximized={maximized} />
            ) : (
              <Suspense fallback={<div className={cn('h-full', SHEET)} />}>
                {pane === 'files' ? (
                  <FilesPanel projectPath={projectPath} maximized={maximized} />
                ) : pane === 'browser' ? (
                  <BrowserPane projectPath={projectPath} maximized={maximized} />
                ) : (
                  artifact && (
                    <ArtifactPane
                      key={artifact}
                      projectPath={projectPath}
                      id={artifact}
                      maximized={maximized}
                    />
                  )
                )}
              </Suspense>
            )}
          </ResizablePanel>
        </>
      )}
    </ResizablePanelGroup>
  )
}
