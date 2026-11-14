import { useSessionsStore } from '@renderer/stores/sessions'
import { useTasksStore } from '@renderer/stores/tasks'
import { openMarketplace, openSession } from '@renderer/stores/view'

/** How long a started task's first session is waited for before nothing more opens. */
const FIRST_SESSION_WAIT = 60_000

/** The task's first step session, once the window knows both it and the session's summary. */
function firstSession(taskId: string): { id: string; projectPath: string } | null {
  const id = useTasksStore
    .getState()
    .views[taskId]?.rounds.find((round) => round.sessionId !== null)?.sessionId
  const summary = id ? useSessionsStore.getState().byId[id] : undefined
  return summary ? { id: summary.id, projectPath: summary.projectPath } : null
}

// TODO(#1478): open the task page, the main view { kind: 'task', taskId }, once it exists.
/** Shows a task: for now its first step's session, as soon as the host has started it. */
export function openTask(taskId: string): void {
  const now = firstSession(taskId)
  if (now) {
    openSession(now.id, now.projectPath)
    return
  }
  const check = () => {
    const found = firstSession(taskId)
    if (!found) return
    stop()
    openSession(found.id, found.projectPath)
  }
  const unsubscribe = [useTasksStore.subscribe(check), useSessionsStore.subscribe(check)]
  const timer = setTimeout(() => stop(), FIRST_SESSION_WAIT)
  function stop() {
    clearTimeout(timer)
    for (const off of unsubscribe) off()
  }
}

// TODO(#1478): open the SOP's own Marketplace page, by its id, once the Marketplace has SOPs.
/** Shows the Marketplace, where an SOP is approved and its steps are pinned for every task. */
export function openSopMarketplace(): void {
  openMarketplace()
}
