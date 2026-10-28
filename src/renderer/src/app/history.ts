import { isMac } from '@renderer/lib/platform'
import { useArtifactsStore } from '@renderer/stores/artifacts'
import { useRoutinesStore } from '@renderer/stores/routines'
import { useSessionsStore } from '@renderer/stores/sessions'
import { goBack, goForward, stepBackTo, type HistoryView } from '@renderer/stores/view'

/** The keys of Back and Forward, as tooltips and the shortcuts dialog show them. */
export const HISTORY_SHORTCUTS = isMac
  ? { back: 'Mod+[', forward: 'Mod+]' }
  : { back: 'Alt+←', forward: 'Alt+→' }

/**
 * Whether a view of the history can still show: its session, or a sub-session's parent, is still
 * listed and not archived, its routine not deleted, its artifact not deleted for good.
 */
export function canShow(view: HistoryView): boolean {
  if (view.kind === 'session') return listed(view.sessionId)
  if (view.kind === 'new') return !view.parentId || listed(view.parentId)
  if (view.kind === 'routine') {
    const { byId, loaded } = useRoutinesStore.getState()
    return view.routineId === null || !loaded || view.routineId in byId
  }
  if (view.kind === 'artifact') {
    const { list, deleted } = useArtifactsStore.getState()
    if (!list || !deleted) return true
    return [...list, ...deleted].some((artifact) => artifact.id === view.id)
  }
  return true
}

/** Listed, with no archived session above it, since archiving a session takes its children. */
function listed(sessionId: string): boolean {
  const { byId } = useSessionsStore.getState()
  for (let session = byId[sessionId]; session; session = byId[session.parentId ?? '']) {
    if (session.archivedAt) return false
    if (!session.parentId) return true
  }
  return false
}

export function back(): void {
  goBack(canShow)
}

export function forward(): void {
  goForward(canShow)
}

/** A page's own Back to `view`: a step back when that is where the step before leads, else `open`. */
export function backTo(view: HistoryView, open: () => void): void {
  if (!stepBackTo(view, canShow)) open()
}
