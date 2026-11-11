import { useMemo } from 'react'
import type { ArtifactSummary } from '@shared/artifacts'
import { artifactHost } from '@renderer/lib/host'
import { useArtifactsStore } from '@renderer/stores/artifacts'
import { useWindowHost, useWindowHostAway } from '@renderer/stores/window-host'

export interface WindowArtifacts {
  /** The lists of the window's host, or of every host; null until read. */
  list: ArtifactSummary[] | null
  deleted: ArtifactSummary[] | null
  /** The window is narrowed to a host that is away: the lists are what was last read from it. */
  away: boolean
  /** Whether anything was ever read from the away host. */
  read: boolean
}

/** The artifacts of the host the window shows, or of every host while it shows them all. */
export function useWindowArtifacts(): WindowArtifacts {
  const host = useWindowHost()
  const hostId = host.kind === 'one' ? host.hostId : undefined
  const away = useWindowHostAway() !== null
  const list = useArtifactsStore((s) => s.list)
  const deleted = useArtifactsStore((s) => s.deleted)
  const read = useArtifactsStore((s) => hostId == null || s.hostsRead.includes(hostId))
  const kept = useArtifactsStore((s) => (hostId ? s.awayLists[hostId] : undefined))
  return useMemo(() => {
    if (hostId === undefined) return { list, deleted, away: false, read: true }
    if (away && hostId !== null) {
      return { list: kept ?? [], deleted: [], away: true, read: kept !== undefined }
    }
    const on = (a: ArtifactSummary): boolean => artifactHost(a.id) === hostId
    return {
      list: list && read ? list.filter(on) : null,
      deleted: deleted && read ? deleted.filter(on) : null,
      away: false,
      read: true,
    }
  }, [hostId, away, list, deleted, read, kept])
}
