import { useState } from 'react'
import type { SessionView, ThreadEntry } from '@shared/thread'
import { isFresh, useThreadsStore } from '@renderer/stores/threads'

/** One entry of a shown session; the component re-renders only when this entry changes. */
export function useEntry<K extends ThreadEntry['kind']>(
  sessionId: string,
  entryId: string,
  kind: K,
): Extract<ThreadEntry, { kind: K }> | undefined {
  const entry = useThreadsStore((s) => s.replicas[sessionId]?.state?.byId[entryId])
  return entry?.kind === kind ? (entry as Extract<ThreadEntry, { kind: K }>) : undefined
}

/** The session as the replica knows it: status, config, usage and commands. */
export function useSessionView(sessionId: string): SessionView | undefined {
  return useThreadsStore((s) => s.replicas[sessionId]?.state?.session)
}

/** Classes for an entry that arrived live: it rises in once; history appears as it is. */
export function useEntryAnimation(sessionId: string, entryId: string): string | undefined {
  const [fresh] = useState(() => isFresh(sessionId, entryId))
  return fresh
    ? 'animate-in fade-in slide-in-from-bottom-1 duration-(--duration-slow) ease-out-quint'
    : undefined
}
