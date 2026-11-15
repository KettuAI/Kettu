import { useEffect, useState } from 'react'
import type { SessionSummary } from '@shared/agent-host'
import type { TaskView } from '@shared/workflow'
import { errorMessage } from '@renderer/lib/host'
import { loadTaskSessions, useTasksStore } from '@renderer/stores/tasks'
import { stepTitle } from './model'

/** Reads already asked for, so rows and cards of the same task ask once. */
const reading = new Map<string, Promise<unknown>>()

function readOnce(key: string, run: () => Promise<unknown>): Promise<unknown> {
  const going = reading.get(key)
  if (going) return going
  const started = run().finally(() => reading.delete(key))
  reading.set(key, started)
  return started
}

/**
 * The task's full view, read the first time `when` holds, then kept current by the host's events;
 * with why the read failed, until a later one works.
 */
export function useTaskView(
  taskId: string,
  when = true,
): { view: TaskView | undefined; error: string | null; retry: () => void } {
  const view = useTasksStore((s) => s.views[taskId])
  const [error, setError] = useState<string | null>(null)
  const [tries, setTries] = useState(0)
  useEffect(() => {
    if (!when || view) return
    let live = true
    readOnce(`view:${taskId}`, () => useTasksStore.getState().read(taskId)).then(
      () => live && setError(null),
      (reason: unknown) => live && setError(errorMessage(reason)),
    )
    return () => {
      live = false
    }
  }, [taskId, when, view, tries])
  return { view, error, retry: () => setTries((n) => n + 1) }
}

/**
 * Reads the task's step sessions into the session list while `when` holds, again as steps start,
 * since the list leaves them out.
 */
export function useTaskSessions(taskId: string, sessionIds: string, when = true): void {
  useEffect(() => {
    if (!when || !sessionIds) return
    void readOnce(`sessions:${taskId}:${sessionIds}`, () => loadTaskSessions(taskId)).catch(
      () => {},
    )
  }, [taskId, sessionIds, when])
}

/**
 * The title a step's session shows beside its task's crumb: the step's name while the session
 * keeps the name Kettu gave it, which repeats the task's; the user's own name once renamed.
 */
export function useStepSessionTitle(summary: SessionSummary): string | null {
  const ref = summary.task
  const view = useTasksStore((s) => (ref ? s.views[ref.taskId] : undefined))
  const name = useTasksStore((s) =>
    ref ? s.summaries[ref.taskId]?.steps.find((step) => step.id === ref.stepId)?.name : undefined,
  )
  if (!ref || !name) return null
  const title = summary.title?.trim()
  if (title && !title.endsWith(` · ${name}`)) return null
  return stepTitle(view?.workflow, ref.stepId, name)
}
