import { useEffect, useState } from 'react'
import type { MemoryEntry, MemoryImportScan, MemoryOverview, MemoryScope } from '@shared/memory'
import { basename } from '@renderer/lib/format'
import { onHost } from '@renderer/lib/host-paths'
import { memoryErrorText } from '@renderer/lib/memory-errors'
import { agentName } from '@renderer/stores/agents'
import { useHostScope } from '@renderer/stores/host-scope'
import { useMemoryChanges } from '@renderer/stores/memory'
import { useProjectsStore } from '@renderer/stores/projects'

/** A read of the host's memory: null until it came, then kept while a change reads it again. */
export interface MemoryRead<T> {
  value: T | null
  error: string | null
  retry: () => void
}

/**
 * Reads from the Settings host again whenever its memory changes. `key` names what `read` reads,
 * null for nothing; a new key starts from nothing rather than show what the last one read.
 */
function useMemoryRead<T>(key: string | null, read: (() => Promise<T>) | null): MemoryRead<T> {
  const { hostId } = useHostScope()
  const changes = useMemoryChanges(hostId)
  const [attempt, setAttempt] = useState(0)
  const at = key === null ? null : `${hostId ?? ''}\n${key}`
  const [state, setState] = useState<{ at: string | null; value: T | null; error: string | null }>({
    at: null,
    value: null,
    error: null,
  })
  useEffect(() => {
    if (at === null || read === null) return
    let live = true
    read().then(
      (value) => {
        if (live) setState({ at, value, error: null })
      },
      (reason: unknown) => {
        if (!live) return
        setState((s) => ({
          at,
          value: s.at === at ? s.value : null,
          error: memoryErrorText(reason),
        }))
      },
    )
    return () => {
      live = false
    }
    // `read` is made anew each render; `at` names what it reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at, changes, attempt])
  const mine = at !== null && state.at === at
  return {
    value: mine ? state.value : null,
    error: mine ? state.error : null,
    retry: () => setAttempt((n) => n + 1),
  }
}

/** Settings › Memory's first read: the switch, global memory and the projects. */
export function useMemoryOverview(): MemoryRead<MemoryOverview> {
  const { request } = useHostScope()
  return useMemoryRead('overview', () => request('memory.overview', undefined))
}

/** The entries of a layer, newest first; null scope reads nothing. */
export function useMemoryEntries(scope: MemoryScope | null): MemoryRead<MemoryEntry[]> {
  const { request } = useHostScope()
  return useMemoryRead(
    scope === null ? null : scope.layer === 'global' ? 'global' : `project\n${scope.project}`,
    scope === null ? null : () => request('memory.list', { scope }),
  )
}

/** What the agents' own memories hold that Kettu's has not imported, read while `on`. */
export function useImportScan(on: boolean): MemoryRead<MemoryImportScan> {
  const { request } = useHostScope()
  return useMemoryRead(on ? 'import' : null, () => request('memory.importScan', undefined))
}

/** Who wrote an entry last: its agent's name, or null for the user. */
export function writerName(entry: MemoryEntry, hostId: string | null): string | null {
  return entry.source.agentId === null ? null : agentName(entry.source.agentId, hostId)
}

/** A project's name as the window lists the host's projects, else its folder's name. */
export function useProjectName(hostId: string | null, project: string | null): string {
  const name = useProjectsStore((s) =>
    project === null
      ? null
      : (s.projects.find((p) => p.path === onHost(hostId, project))?.name ?? null),
  )
  return name ?? (project === null ? '' : basename(project))
}
