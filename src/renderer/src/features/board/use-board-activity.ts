import { useEffect, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { SessionSummary } from '@shared/agent-host'
import type { BackgroundTaskView } from '@shared/thread'
import { subagentRunning } from '@renderer/features/session/subagent/progress'
import { useBoardStore } from '@renderer/stores/board'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useThreadsStore } from '@renderer/stores/threads'
import { useViewStore } from '@renderer/stores/view'
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

const NO_KEYS: readonly string[] = []

function runningTaskKeys(tasks: readonly BackgroundTaskView[] | undefined): string[] {
  return tasks ? tasks.filter((task) => task.status === 'running').map((t) => `task:${t.id}`) : []
}

// A sub-agent that starts waiting for the user is news again, so its state is part of its key.
function subagentKeys(byId: Record<string, SessionSummary>, parentId: string): string[] {
  const keys: string[] = []
  for (const child of Object.values(byId)) {
    if (child.parentId !== parentId || child.origin !== 'subagent') continue
    if (subagentWaiting(child)) keys.push(`agent:${child.id}:needs`)
    else if (subagentRunning(child)) keys.push(`agent:${child.id}:running`)
  }
  return keys
}

function sameKeys(a: readonly string[] | undefined, b: readonly string[]): boolean {
  return !!a && a.length === b.length && a.every((key, i) => key === b[i])
}

/**
 * What the Board's button gives a dot for: a command or sub-agent that started, or a sub-agent
 * that began waiting for the user, since the board last showed it. What is there when the button
 * first shows, and everything while the board is open, counts as seen.
 */
export function useBoardNews(sessionId: string | null): 'needs' | 'news' | undefined {
  const key = sessionId ?? ''
  const loaded = useThreadsStore((s) => !!s.replicas[key]?.state)
  const tasks = useThreadsStore(
    useShallow((s) =>
      key ? runningTaskKeys(s.replicas[key]?.state?.session.background) : NO_KEYS,
    ),
  )
  const agents = useSessionsStore(useShallow((s) => (key ? subagentKeys(s.byId, key) : NO_KEYS)))
  const seen = useBoardStore((s) => s.seen[key])
  const open = useViewStore((s) => s.sidePane[key] === 'board')
  const keys = useMemo(() => [...tasks, ...agents], [tasks, agents])
  useEffect(() => {
    if (key === '' || !loaded || !(open || seen === undefined) || sameKeys(seen, keys)) return
    useBoardStore.setState((s) => ({ seen: { ...s.seen, [key]: keys } }))
  }, [key, loaded, open, seen, keys])
  if (open || !seen) return undefined
  const fresh = keys.filter((k) => !seen.includes(k))
  if (fresh.length === 0) return undefined
  return fresh.some((k) => k.endsWith(':needs')) ? 'needs' : 'news'
}
