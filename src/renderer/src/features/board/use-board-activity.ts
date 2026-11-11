import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { SessionSummary } from '@shared/agent-host'
import type { BackgroundTaskView } from '@shared/thread'
import { subagentRunning } from '@renderer/features/session/subagent/progress'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useThreadsStore } from '@renderer/stores/threads'
import { subagentWaiting, type BoardActivity } from './board-model'

const NONE: BoardActivity = { running: 0, needs: 0 }

function runningTasks(tasks: readonly BackgroundTaskView[] | undefined): number {
  return tasks ? tasks.filter((task) => task.status === 'running').length : 0
}

function subagentCounts(byId: Record<string, SessionSummary>, parentId: string): BoardActivity {
  let running = 0
  let needs = 0
  for (const child of Object.values(byId)) {
    if (child.parentId !== parentId || child.origin !== 'subagent') continue
    if (subagentWaiting(child)) needs++
    else if (subagentRunning(child)) running++
  }
  return { running, needs }
}

/**
 * What a session has going, for the Board's button and head. Both counts are numbers, so a
 * component using this re-renders when one changes and not on every update of the stores.
 */
export function useBoardActivity(sessionId: string | null): BoardActivity {
  const tasks = useThreadsStore((s) =>
    sessionId ? runningTasks(s.replicas[sessionId]?.state?.session.background) : 0,
  )
  const agents = useSessionsStore(
    useShallow((s) => (sessionId ? subagentCounts(s.byId, sessionId) : NONE)),
  )
  return useMemo(
    () => ({ running: tasks + agents.running, needs: agents.needs }),
    [tasks, agents.running, agents.needs],
  )
}
