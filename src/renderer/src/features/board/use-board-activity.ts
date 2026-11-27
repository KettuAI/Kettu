import { useEffect, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { BackgroundTaskView } from '@shared/thread'
import { useBoardStore } from '@renderer/stores/board'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useThreadsStore } from '@renderer/stores/threads'
import { useViewStore } from '@renderer/stores/view'
import { boardChildActivity, boardChildKeys, type BoardActivity } from './board-model'

const NONE: BoardActivity = { running: 0, needs: 0 }

function runningTasks(tasks: readonly BackgroundTaskView[] | undefined): number {
  return tasks ? tasks.filter((task) => task.status === 'running').length : 0
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
    useShallow((s) => (sessionId ? boardChildActivity(s.byId, sessionId) : NONE)),
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

function sameKeys(a: readonly string[] | undefined, b: readonly string[]): boolean {
  return !!a && a.length === b.length && a.every((key, i) => key === b[i])
}

/**
 * What the Board's button gives a dot for: a command, sub-agent or child session that started, or
 * one that began waiting for the user, since the board last showed it. What is there when the
 * button first shows, and everything while the board is open, counts as seen.
 */
export function useBoardNews(sessionId: string | null): 'needs' | 'news' | undefined {
  const key = sessionId ?? ''
  const loaded = useThreadsStore((s) => !!s.replicas[key]?.state)
  const tasks = useThreadsStore(
    useShallow((s) =>
      key ? runningTaskKeys(s.replicas[key]?.state?.session.background) : NO_KEYS,
    ),
  )
  const agents = useSessionsStore(useShallow((s) => (key ? boardChildKeys(s.byId, key) : NO_KEYS)))
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
