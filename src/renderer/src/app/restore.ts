import type { SessionSummary } from '@shared/agent-host'
import { pruneLayout, readLayout, type Layout } from '@renderer/features/split/layout'
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
}: {
  enabled: boolean
  /** The split the last run saved, or null. */
  layout: unknown
  /** The session an earlier run showed, saved before the split view. */
  lastSessionId: string | null
  main: MainView
  byId: Record<string, SessionSummary>
}): LaunchTarget {
  if (main.kind !== 'launch') return null
  if (!enabled) return { kind: 'new' }
  const restored = savedLayout(layout, byId)
  if (restored) return { kind: 'layout', layout: restored }
  const summary = lastSessionId ? byId[lastSessionId] : undefined
  return summary ? { kind: 'session', summary } : { kind: 'new' }
}

/**
 * The saved split with the sessions that are still listed: a pane whose session is gone closes,
 * and the one in focus leaves for New session when no session is left among the others.
 */
export function savedLayout(saved: unknown, byId: Record<string, SessionSummary>): Layout | null {
  const layout = readLayout(saved)
  if (!layout) return null
  const pruned = pruneLayout(
    layout,
    (pane) => pane.view.kind === 'new' || !!byId[pane.view.sessionId],
  )
  if (!pruned) return null
  const withPaths: Layout = {
    ...pruned,
    columns: pruned.columns.map((column) => ({
      ...column,
      panes: column.panes.map((pane) =>
        pane.view.kind === 'session'
          ? {
              ...pane,
              view: { ...pane.view, projectPath: byId[pane.view.sessionId]!.projectPath },
            }
          : pane,
      ),
    })),
  }
  const sessions = withPaths.columns.some((column) =>
    column.panes.some((pane) => pane.view.kind === 'session'),
  )
  // A save of New session alone comes back as New session alone.
  return sessions
    ? withPaths
    : { ...withPaths, columns: [withPaths.columns[0]!], focus: withPaths.columns[0]!.panes[0]!.id }
}
