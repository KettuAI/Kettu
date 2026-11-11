import { create } from 'zustand'
import { isMac } from '@renderer/lib/platform'
import { useArtifactsStore } from '@renderer/stores/artifacts'
import { useRoutinesStore } from '@renderer/stores/routines'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useTasksStore } from '@renderer/stores/tasks'
import {
  goBack,
  goForward,
  goTo,
  stepBackTo,
  stepShows,
  type HistoryView,
  type Step,
} from '@renderer/stores/view'

/** The keys of Back, Forward and the whole history, as tooltips and menus show them. */
export const HISTORY_SHORTCUTS = isMac
  ? { back: 'Mod+[', forward: 'Mod+]', all: 'Mod+Y' }
  : { back: 'Alt+←', forward: 'Alt+→', all: 'Mod+H' }

/**
 * The letter that shows the whole history with Mod: Y on macOS, as in Safari and Chrome; H
 * elsewhere, as in Chrome, since Ctrl+Y redoes there.
 */
export function historyKey(platform: string): 'y' | 'h' {
  return platform === 'darwin' ? 'y' : 'h'
}

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
  if (view.kind === 'task') {
    const { byId, reads } = useTasksStore.getState()
    // Until this computer's tasks are read, one is not known to be gone.
    return view.taskId in byId || !reads['']?.loaded
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

/**
 * The steps Back or Forward can still show, nearest first, as their menus list them. A step whose
 * place can no longer show is left out even when its page and panes can, as a step that only
 * closes Settings over a session archived since.
 */
export function historyPlaces(
  history: { back: Step[]; forward: Step[] },
  direction: 'back' | 'forward',
): Step[] {
  return history[direction]
    .filter(({ place }) => place.kind === 'settings' || (place.kind !== 'launch' && canShow(place)))
    .filter((step) => stepShows(step, canShow))
    .reverse()
}

/** Goes back or forward to a place of that list in one step, passing the ones between. */
export function goToPlace(direction: 'back' | 'forward', step: Step): void {
  goTo(direction, step, canShow)
}

/** The whole history's dialog, over whatever the window shows. */
export const useHistoryDialog = create<{ open: boolean }>()(() => ({ open: false }))

export function showHistory(open: boolean): void {
  useHistoryDialog.setState({ open })
}

/** Closes the history when open, and otherwise opens it unless another layer is open. */
export function toggleHistory(layerOpen: boolean): void {
  const { open } = useHistoryDialog.getState()
  if (open || !layerOpen) showHistory(!open)
}
