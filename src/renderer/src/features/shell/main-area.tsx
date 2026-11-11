import { lazy, Suspense, useEffect, type ReactNode } from 'react'
import { LaunchState } from '@renderer/features/shell/launch-state'
import { SHEET } from '@renderer/features/shell/sheet'
import { SidePanelArea } from '@renderer/features/shell/side-panel-area'
import { SplitView } from '@renderer/features/split/split-view'
import { focusedPane } from '@renderer/features/split/layout'
import { cn } from '@renderer/lib/utils'
import { showProjects } from '@renderer/stores/git'
import { useProjectsStore } from '@renderer/stores/projects'
import { panelOf, shownLayoutSessions, shownProjects, useViewStore } from '@renderer/stores/view'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useSessionFolder } from '@renderer/lib/session-folder'

const UsagePage = lazy(() => import('@renderer/features/usage/usage-page'))
const RoutinesPage = lazy(() => import('@renderer/features/routines/routines-page'))
const RoutinePage = lazy(() => import('@renderer/features/routines/routine-page'))
const ArtifactsPage = lazy(() => import('@renderer/features/artifacts/artifacts-page'))
const ArtifactViewer = lazy(() => import('@renderer/features/artifacts/artifact-viewer'))
const MarketplacePage = lazy(() => import('@renderer/features/marketplace/marketplace-page'))

/**
 * What the main area shows: the split of sessions and New session, the usage page, the routines
 * pages, the Artifacts page, an artifact, or the Marketplace. A page shows alone, and the split
 * waits as it was.
 */
export function MainArea() {
  const projects = useProjectsStore((s) => s.projects)
  const selected = useViewStore((s) => s.projectPath)
  const main = useViewStore((s) => s.main)
  const layout = useViewStore((s) => s.layout)
  const paths = useViewStore(shownProjects)
  const shownSessions = useViewStore((s) => shownLayoutSessions(s).join('\n'))
  // The worktrees the sessions in view work in, which their panels follow.
  const worktrees = useSessionsStore((s) =>
    shownSessions
      .split('\n')
      .flatMap((id) => {
        const path = s.byId[id]?.worktree?.path
        return path ? [path] : []
      })
      .join('\n'),
  )
  const focused = focusedPane(layout).view
  const focusedFolder = useSessionFolder(focused.kind === 'session' ? focused.sessionId : null)

  // Every project or worktree a pane in view works in keeps its git status live.
  useEffect(() => {
    const folders = [paths, worktrees].filter(Boolean).join('\n')
    showProjects(folders ? [...new Set(folders.split('\n'))] : [])
  }, [paths, worktrees])

  if (main.kind === 'usage') {
    return (
      <PageSheet>
        <Suspense fallback={null}>
          <UsagePage />
        </Suspense>
      </PageSheet>
    )
  }
  if (main.kind === 'routines') {
    return (
      <PageSheet>
        <Suspense fallback={null}>
          <RoutinesPage />
        </Suspense>
      </PageSheet>
    )
  }
  if (main.kind === 'routine') {
    return (
      <PageSheet>
        <Suspense fallback={null}>
          <RoutinePage
            key={main.routineId ?? `new:${main.example ?? ''}`}
            routineId={main.routineId}
            example={main.example ?? null}
          />
        </Suspense>
      </PageSheet>
    )
  }
  if (main.kind === 'artifacts') {
    return (
      <PageSheet>
        <Suspense fallback={null}>
          <ArtifactsPage deleted={main.deleted === true} />
        </Suspense>
      </PageSheet>
    )
  }
  if (main.kind === 'artifact') {
    return (
      <PageSheet>
        <Suspense fallback={null}>
          <ArtifactViewer key={main.id} id={main.id} history={main.history === true} />
        </Suspense>
      </PageSheet>
    )
  }
  if (main.kind === 'marketplace') {
    return (
      <PageSheet>
        <Suspense fallback={null}>
          <MarketplacePage item={main.item ?? null} tab={main.tab ?? 'all'} />
        </Suspense>
      </PageSheet>
    )
  }
  if (main.kind === 'launch') {
    return (
      <PageSheet>
        <LaunchState />
      </PageSheet>
    )
  }

  // The side panel is the pane in focus's, and New session at No project has none. The area stays
  // around the split even then, so the panes do not mount again as the focus moves.
  const view = focused
  const panel = panelOf(view)
  // A session's panel is its working folder's: its worktree's when it has one.
  const panelPath = focusedFolder || view.projectPath || selected || projects[0]?.path || null
  if (!panelPath) {
    return (
      <PageSheet>
        <SplitView />
      </PageSheet>
    )
  }
  return (
    <SidePanelArea projectPath={panelPath} panel={panel}>
      <SplitView />
    </SidePanelArea>
  )
}

/** A page alone on the main area's sheet; SidePanelArea lays out the sheets beside its pane. */
function PageSheet({ children }: { children: ReactNode }) {
  return <div className={cn('h-full', SHEET)}>{children}</div>
}
