import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react'
import { useDefaultLayout } from 'react-resizable-panels'
import { onAppEvent } from '@renderer/app/events'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@renderer/components/ui/resizable'
import { TerminalPanel } from '@renderer/features/terminal/terminal-panel'
import { hostOfPath } from '@renderer/lib/host-paths'
import { layoutStorage } from '@renderer/lib/storage'
import { cn } from '@renderer/lib/utils'
import {
  createTerminal,
  finishTerminalLoad,
  loadTerminals,
  trackTerminalOpen,
} from '@renderer/stores/terminals'
import { useTerminalAllowed } from '@renderer/stores/hosts'
import { prefersReducedMotion } from '@renderer/stores/settings'
import { toggleTerminal, useViewStore, type SidePane } from '@renderer/stores/view'
import { SHEET, SHEET_PANEL } from './sheet'

const FilesPanel = lazy(() => import('@renderer/features/files/files-panel'))
const ArtifactPane = lazy(() => import('@renderer/features/artifacts/artifact-pane'))
const DevicesPane = lazy(() => import('@renderer/features/devices/devices-pane'))
const BrowserPane = lazy(() =>
  import('@renderer/features/browser/browser-pane').then((module) => ({
    default: module.BrowserPane,
  })),
)

// Each pane is a panel of its own, so each keeps the width the user gives it. The terminal keeps
// the id it had when it was the only pane.
const PANE_SIZE = { defaultSize: '480px', minSize: '360px', maxSize: '760px' } as const
const PANES = {
  terminal: { id: 'side-panel', ...PANE_SIZE },
  files: { id: 'side-panel-files', ...PANE_SIZE },
  artifact: { id: 'side-panel-artifact', defaultSize: '560px', minSize: '360px' },
  browser: { id: 'side-panel-browser', ...PANE_SIZE },
  devices: { id: 'side-panel-devices', ...PANE_SIZE },
} as const

// As long as App Shell's columns take to glide.
const GLIDE_MS = 420

/**
 * The pane the side panel holds and how it moves. Opening or closing glides the columns; a closed
 * pane stays until its glide ends. Switching panes or sessions, dragging and resizing the window
 * do not glide.
 */
function usePaneGlide(panel: string | null, pane: SidePane | undefined) {
  const [held, setHeld] = useState(pane)
  const [heldPanel, setHeldPanel] = useState(panel)
  const [glide, setGlide] = useState<'open' | 'close' | null>(null)
  const still = prefersReducedMotion()
  if (panel !== heldPanel) {
    setHeldPanel(panel)
    setHeld(pane)
    setGlide(null)
  } else if (pane && pane !== held) {
    setHeld(pane)
    setGlide(!still && (held === undefined || glide === 'close') ? 'open' : null)
  } else if (pane && glide === 'close') {
    setGlide('open')
  } else if (!pane && held && glide !== 'close') {
    if (still) setHeld(undefined)
    else setGlide('close')
  }
  useEffect(() => {
    if (!glide) return
    const timer = setTimeout(() => {
      setGlide(null)
      if (glide === 'close') setHeld(undefined)
    }, GLIDE_MS)
    return () => clearTimeout(timer)
  }, [glide])
  return { held, glide }
}

/**
 * The main area with the side panel of the pane in focus on its right: its session's, or New
 * session's in its project, holding the terminal, the files, the browser or, opened from the
 * thread, an artifact. Opening or closing it glides the content's edge as App Shell's work area
 * does. Maximized, the panel covers the whole area while the layout underneath keeps its sizes.
 */
export function SidePanelArea({
  projectPath,
  panel,
  children,
}: {
  projectPath: string
  /** Null at New session with No project, which has no side panel. */
  panel: string | null
  children: ReactNode
}) {
  const remote = hostOfPath(projectPath) !== null
  const terminal = useTerminalAllowed(projectPath)
  // Another host's project has its files, its artifacts and this computer's browser through its
  // connection, and its terminal while the host allows it.
  const pane = useViewStore((s) => {
    const shown = panel ? s.sidePane[panel] : undefined
    if (!remote || shown === 'files' || shown === 'browser' || shown === 'artifact') return shown
    return shown === 'terminal' && terminal ? shown : undefined
  })
  const artifactId = useViewStore((s) => (panel ? s.sideArtifact[panel] : undefined))
  const maximized = useViewStore((s) => s.sidePaneMaximized) && !!pane
  const open = pane === 'terminal'
  const { held, glide } = usePaneGlide(panel, pane)
  const layout = useDefaultLayout({
    id: 'side-panel',
    panelIds: held ? ['content', PANES[held].id] : ['content'],
    storage: layoutStorage,
    onlySaveAfterUserInteractions: true,
  })
  const previous = useRef({ panel: panel ?? '', open })
  // Stays set for a second run of one open, so that run still starts a tab instead of closing.
  const opening = useRef(false)

  // Opening the pane in a panel without terminals starts one. A pane already open, restored or
  // reached by switching sessions, closes once the list comes back empty. A list that fails, or
  // that finishes after the panel or pane changed, leaves the pane as it is.
  useEffect(() => {
    const now = { panel: panel ?? '', open }
    const tracked = trackTerminalOpen(previous.current, now, opening.current)
    opening.current = tracked.opening
    previous.current = now
    if (!open || !panel) return
    let stale = false
    void loadTerminals(projectPath).then((loaded) => {
      finishTerminalLoad(projectPath, panel, { explicitOpen: tracked.explicitOpen, stale, loaded })
    })
    return () => {
      stale = true
    }
  }, [projectPath, panel, open])

  useEffect(
    () =>
      onAppEvent((event) => {
        if (!terminal || !panel) return
        if (event.kind === 'new-terminal') {
          toggleTerminal(panel, true)
          void createTerminal(projectPath, panel)
        } else if (event.kind === 'run-in-terminal' && event.panel === panel) {
          toggleTerminal(panel, true)
          void createTerminal(projectPath, panel, undefined, { text: event.command, run: false })
        } else if (event.kind === 'sign-in-terminal' && event.panel === panel) {
          toggleTerminal(panel, true)
          void createTerminal(projectPath, panel, undefined, {
            text: event.command,
            run: true,
            signInAgent: event.agentId,
          })
        }
      }),
    [projectPath, panel, terminal],
  )

  return (
    <ResizablePanelGroup
      orientation="horizontal"
      defaultLayout={layout.defaultLayout}
      onLayoutChanged={layout.onLayoutChanged}
      className="kettu-pane-area relative"
      data-glide={glide ?? undefined}
      style={SHEET_PANEL}
    >
      <ResizablePanel id="content" minSize="360px" className="min-w-0" style={SHEET_PANEL}>
        {/* Under the maximized panel the content keeps its state but is not rendered, and its
            sheet's edge gives way to the panel's. */}
        <div inert={maximized} className={cn('h-full', maximized && '[content-visibility:hidden]')}>
          {children}
        </div>
      </ResizablePanel>
      {held && (
        <>
          {/* The desk between the two sheets, with a faint line along it while it is dragged. */}
          <ResizableHandle
            className={cn(
              'kp-resizer app-region-no-drag w-(--sheet-gap)',
              maximized && 'pointer-events-none',
            )}
          />
          <ResizablePanel
            key={held}
            {...PANES[held]}
            groupResizeBehavior="preserve-pixel-size"
            className="min-w-0"
            style={SHEET_PANEL}
          >
            {held === 'terminal' && panel ? (
              <TerminalPanel projectPath={projectPath} panel={panel} maximized={maximized} />
            ) : (
              panel && (
                <Suspense fallback={<div className={cn('h-full', SHEET)} />}>
                  {held === 'files' ? (
                    <FilesPanel projectPath={projectPath} panel={panel} maximized={maximized} />
                  ) : held === 'browser' ? (
                    <BrowserPane panel={panel} maximized={maximized} />
                  ) : held === 'devices' ? (
                    <DevicesPane panel={panel} maximized={maximized} />
                  ) : (
                    artifactId && (
                      <ArtifactPane
                        key={artifactId}
                        projectPath={projectPath}
                        panel={panel}
                        id={artifactId}
                        maximized={maximized}
                      />
                    )
                  )}
                </Suspense>
              )
            )}
          </ResizablePanel>
        </>
      )}
    </ResizablePanelGroup>
  )
}
