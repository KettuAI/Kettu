import { lazy, Suspense, useEffect, type ReactNode } from 'react'
import { LaunchState } from '@renderer/features/shell/launch-state'
import { SHEET } from '@renderer/features/shell/sheet'
import { SidePanelArea } from '@renderer/features/shell/side-panel-area'
import { SplitView } from '@renderer/features/split/split-view'
import { focusedPane, type Layout } from '@renderer/features/split/layout'
import { cn } from '@renderer/lib/utils'
import { showProjects } from '@renderer/stores/git'
import { useProjectsStore } from '@renderer/stores/projects'
import { shownProjects, useViewStore } from '@renderer/stores/view'

const UsagePage = lazy(() => import('@renderer/features/usage/usage-page'))
const RoutinesPage = lazy(() => import('@renderer/features/routines/routines-page'))
const RoutinePage = lazy(() => import('@renderer/features/routines/routine-page'))
const ArtifactsPage = lazy(() => import('@renderer/features/artifacts/artifacts-page'))
const ArtifactViewer = lazy(() => import('@renderer/features/artifacts/artifact-viewer'))

/**
 * What the main area shows: the split of sessions and New session, the usage page, the routines
 * pages, the Artifacts page, or an artifact. A page shows alone, and the split waits as it was.
 */
export function MainArea() {
  const projects = useProjectsStore((s) => s.projects)
  const selected = useViewStore((s) => s.projectPath)
  const main = useViewStore((s) => s.main)
  const layout = useViewStore((s) => s.layout)
  const paths = useViewStore(shownProjects)

  // Every project a pane in view works in keeps its git status live.
  useEffect(() => {
    showProjects(paths ? paths.split('\n') : [])
  }, [paths])

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
          <RoutinePage key={main.routineId ?? 'new'} routineId={main.routineId} />
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
  if (main.kind === 'launch') {
    return (
      <PageSheet>
        <LaunchState />
      </PageSheet>
    )
  }

  // The side panel serves the pane in focus, and New session at No project keeps the one it had.
  const panelPath = focusedPaneProject(layout) ?? selected ?? projects[0]?.path ?? null
  if (!panelPath) {
    return (
      <PageSheet>
        <SplitView />
      </PageSheet>
    )
  }
  return (
    <SidePanelArea projectPath={panelPath}>
      <SplitView />
    </SidePanelArea>
  )
}

function focusedPaneProject(layout: Layout): string | null {
  return focusedPane(layout).view.projectPath || null
}

/** A page alone on the main area's sheet; SidePanelArea lays out the sheets beside its pane. */
function PageSheet({ children }: { children: ReactNode }) {
  return <div className={cn('h-full', SHEET)}>{children}</div>
}
