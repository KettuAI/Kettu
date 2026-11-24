import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  useDefaultLayout,
  useGroupRef,
  usePanelRef,
  type Layout,
  type LayoutChangedMeta,
} from 'react-resizable-panels'
import { onAppEvent } from '@renderer/app/events'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@renderer/components/ui/resizable'
import { useToastArea } from '@renderer/components/ui/toast'
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
import { shownDoc, toggleTerminal, useViewStore, type SidePane } from '@renderer/stores/view'
import { usePhoneWindow } from './narrow'
import { SHEET, SHEET_PANEL } from './sheet'
import { SurfacesPane, SurfaceTabs } from './surface-tabs'

const FilesPanel = lazy(() => import('@renderer/features/files/files-panel'))
const DocPane = lazy(() => import('@renderer/features/files/doc-pane'))
const ArtifactViewer = lazy(() => import('@renderer/features/artifacts/artifact-viewer'))
const DevicesPane = lazy(() => import('@renderer/features/devices/devices-pane'))
const ComputerPane = lazy(() => import('@renderer/features/computer/computer-pane'))
const RequestsPane = lazy(() => import('@renderer/features/requests/requests-pane'))
const BoardPane = lazy(() => import('@renderer/features/board/board-pane'))
const SideChatPane = lazy(() => import('@renderer/features/side-chat/side-chat-rail'))
const GitPane = lazy(() => import('@renderer/features/git/pane/git-pane'))
const PluginPane = lazy(() => import('@renderer/features/plugin-views/plugin-pane'))
const BrowserPane = lazy(() =>
  import('@renderer/features/browser/browser-pane').then((module) => ({
    default: module.BrowserPane,
  })),
)

// The content and the panel share one minimum width.
const MIN_WIDTH = 360
// The panel keeps one width whatever tab it shows.
const PANEL = { id: 'side-panel', defaultSize: '480px', minSize: MIN_WIDTH } as const

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
 * session's in its project, with one row of tabs for everything open there. Opening or closing
 * it glides the content's edge as App Shell's work area does. Maximized, the panel covers the whole area while the layout underneath keeps its sizes.
 * Dragging the edge past the content's minimum folds the content away and maximizes the panel.
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
    if (!remote) return shown
    if (shown === 'devices' || shown === 'computer') return undefined
    return shown === 'terminal' && !terminal ? undefined : shown
  })
  const doc = useViewStore((s) => shownDoc(s, panel))
  const artifactId = doc?.kind === 'artifact' ? doc.id : undefined
  // A phone has no room beside the thread: a pane always covers the whole area there.
  const phone = usePhoneWindow()
  const maximized = (useViewStore((s) => s.sidePaneMaximized) || phone) && !!pane
  const open = pane === 'terminal'
  const { held, glide } = usePaneGlide(panel, pane)
  const layout = useDefaultLayout({
    id: 'side-panel',
    panelIds: held ? ['content', PANEL.id] : ['content'],
    storage: layoutStorage,
    onlySaveAfterUserInteractions: true,
  })
  const groupRef = useGroupRef()
  const contentRef = usePanelRef()
  const contentBox = useRef<HTMLDivElement>(null)
  const paneRef = usePanelRef()
  // The layout before the drag that folds the content, which Restore brings back.
  const settled = useRef<Layout | null>(null)
  const [folded, setFolded] = useState(false)
  // Toasts centre over the content, clear of the pane's native page; once the pane covers the
  // area they centre over all of it.
  useToastArea('content', contentBox, !maximized && !folded)
  // Layout changes made here wait a frame, out of the library's own callback.
  const onLayoutChanged = (next: Layout, meta: LayoutChangedMeta) => {
    if (!contentRef.current?.isCollapsed()) {
      settled.current = next
      layout.onLayoutChanged(next, meta)
      return
    }
    if (meta.isUserInteraction) {
      const back = settled.current
      useViewStore.setState({ sidePaneMaximized: true })
      requestAnimationFrame(() => {
        if (back) groupRef.current?.setLayout(back)
        else contentRef.current?.expand()
      })
      return
    }
    // A narrower window folds it too. While both still fit, the pane gives way instead; otherwise
    // it unfolds once the window grows again.
    requestAnimationFrame(() => {
      if ((paneRef.current?.getSize().inPixels ?? 0) >= MIN_WIDTH * 2) {
        contentRef.current?.resize(MIN_WIDTH)
      }
    })
  }
  const previous = useRef({ panel: panel ?? '', open })
  // Stays set for a second run of one open, so that run still starts a tab instead of closing.
  const opening = useRef(false)

  // Opening the terminals in a panel without any starts one. One already shown, restored or
  // reached by switching sessions, gives way once the list comes back empty. A list that fails, or
  // that finishes after the panel or pane changed, leaves the pane as it is.
  useEffect(() => {
    const now = { panel: panel ?? '', open }
    const tracked = trackTerminalOpen(previous.current, now, opening.current)
    opening.current = tracked.opening
    previous.current = now
    if (!open || !panel) return
    let stale = false
    void loadTerminals(projectPath, panel).then((loaded) => {
      finishTerminalLoad(projectPath, panel, { explicitOpen: tracked.explicitOpen, stale, loaded })
    })
    return () => {
      stale = true
    }
  }, [projectPath, panel, open])

  // Whatever the panel shows, its row lists the terminals the session still has.
  const listed = !!pane && pane !== 'terminal' && terminal
  useEffect(() => {
    if (listed && panel) void loadTerminals(projectPath)
  }, [projectPath, panel, listed])

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
        } else if (event.kind === 'open-terminal' && event.panel === panel) {
          toggleTerminal(panel, true)
          void createTerminal(projectPath, panel, undefined, { folder: event.folder })
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
      groupRef={groupRef}
      defaultLayout={layout.defaultLayout}
      onLayoutChanged={onLayoutChanged}
      className="kettu-pane-area relative"
      data-glide={glide ?? undefined}
      style={SHEET_PANEL}
    >
      <ResizablePanel
        id="content"
        panelRef={contentRef}
        elementRef={contentBox}
        minSize={MIN_WIDTH}
        collapsible
        onResize={(size) => setFolded(size.inPixels === 0)}
        className="min-w-0"
        style={SHEET_PANEL}
      >
        {/* Under the maximized panel, or folded away, the content keeps its state but is not
            rendered, and its sheet's edge gives way to the panel's. */}
        <div
          inert={maximized || folded}
          className={cn('h-full', (maximized || folded) && '[content-visibility:hidden]')}
        >
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
            panelRef={paneRef}
            {...PANEL}
            groupResizeBehavior="preserve-pixel-size"
            className="min-w-0"
            style={SHEET_PANEL}
          >
            {panel && (
              <div
                data-side-panel={panel}
                data-pane={held}
                data-maximized={maximized || undefined}
                className={cn('kp-pane', SHEET)}
              >
                <SurfaceTabs panel={panel} projectPath={projectPath} maximized={maximized} />
                {held === 'terminal' ? (
                  <TerminalPanel projectPath={projectPath} panel={panel} />
                ) : (
                  <Suspense fallback={<div className="min-h-0 flex-1" />}>
                    {held === 'files' ? (
                      <FilesPanel projectPath={projectPath} panel={panel} />
                    ) : held === 'file' || held === 'diff' ? (
                      <DocPane projectPath={projectPath} panel={panel} />
                    ) : held === 'git' ? (
                      <GitPane panel={panel} projectPath={projectPath} />
                    ) : held === 'browser' ? (
                      <BrowserPane panel={panel} maximized={maximized} />
                    ) : held === 'devices' ? (
                      <DevicesPane panel={panel} />
                    ) : held === 'surfaces' ? (
                      <SurfacesPane panel={panel} projectPath={projectPath} />
                    ) : held === 'computer' ? (
                      <ComputerPane panel={panel} />
                    ) : held === 'requests' ? (
                      <RequestsPane key={panel} panel={panel} />
                    ) : held === 'board' ? (
                      <BoardPane sessionId={panel} />
                    ) : held === 'sideChat' ? (
                      <SideChatPane key={panel} sessionId={panel} />
                    ) : held === 'plugin' ? (
                      <PluginPane panel={panel} projectPath={projectPath} />
                    ) : (
                      artifactId && (
                        <ArtifactViewer
                          key={artifactId}
                          where="panel"
                          projectPath={projectPath}
                          panel={panel}
                          id={artifactId}
                          maximized={maximized}
                        />
                      )
                    )}
                  </Suspense>
                )}
              </div>
            )}
          </ResizablePanel>
        </>
      )}
    </ResizablePanelGroup>
  )
}
