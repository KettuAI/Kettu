import type { SessionSummary } from '@shared/agent-host'
import {
  allPanes,
  mapPanes,
  pruneLayout,
  readLayout,
  type Layout,
} from '@renderer/features/split/layout'
import type { MainView } from '@renderer/stores/view'

/** What replaces the launch view, unless something was opened first. */
export type LaunchTarget =
  | { kind: 'layout'; layout: Layout }
  | { kind: 'session'; summary: SessionSummary }
  | { kind: 'new' }
  | null

/**
 * The split the last run left, with the sessions still listed, when the setting is on; New session
 * with it off. A save made before the split view opens its one session, or New session with that
 * session gone.
 */
export function launchTarget({
  enabled,
  layout,
  lastSessionId,
  main,
  byId,
  waiting = () => false,
}: {
  enabled: boolean
  /** The split the last run saved, or null. */
  layout: unknown
  /** The session an earlier run showed, saved before the split view. */
  lastSessionId: string | null
  main: MainView
  byId: Record<string, SessionSummary>
  /** Whether a pane's session, not listed yet, is on a host whose lists have not been read. */
  waiting?: Waiting
}): LaunchTarget {
  if (main.kind !== 'launch') return null
  if (!enabled) return { kind: 'new' }
  const restored = savedLayout(layout, byId, waiting)
  if (restored) return { kind: 'layout', layout: restored }
  const summary = lastSessionId ? byId[lastSessionId] : undefined
  return summary ? { kind: 'session', summary } : { kind: 'new' }
}

export type Waiting = (view: { sessionId: string; projectPath: string }) => boolean

/**
 * The saved split with the sessions that are still listed, or that wait for their host: a pane
 * whose session is gone closes, and the one in focus leaves for New session when no session is
 * left among the others.
 */
export function savedLayout(
  saved: unknown,
  byId: Record<string, SessionSummary>,
  waiting: Waiting = () => false,
): Layout | null {
  const layout = readLayout(saved)
  if (!layout) return null
  const pruned = pruneLayout(
    layout,
    (pane) => pane.view.kind === 'new' || !!byId[pane.view.sessionId] || waiting(pane.view),
  )
  if (!pruned) return null
  const withPaths = mapPanes(pruned, (pane) => {
    const summary = pane.view.kind === 'session' ? byId[pane.view.sessionId] : undefined
    return summary && pane.view.kind === 'session'
      ? { ...pane, view: { ...pane.view, projectPath: summary.projectPath } }
      : pane
  })
  // A save of New session alone comes back as New session alone.
  if (allPanes(withPaths).some((pane) => pane.view.kind === 'session')) return withPaths
  const first = allPanes(withPaths)[0]!
  return { root: { ...first, share: 1 }, focus: first.id }
}
