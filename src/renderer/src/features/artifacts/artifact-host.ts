// The host an artifact is kept on, for the parts that show it: its sharing, what it offers and
// whether it is reached. An artifact of this computer's takes the window's own.

import type { ArtifactRecord } from '@shared/remote/host-admin'
import { artifactHost } from '@renderer/lib/host'
import { isWeb } from '@renderer/lib/platform'
import { useConnectionStore } from '@renderer/stores/connection'
import { hostScope, LOCAL_SCOPE } from '@renderer/stores/host-scope'
import { useHostsStore } from '@renderer/stores/hosts'
import { localSharing, type Sharing } from '@renderer/stores/sharing'

/** The sharing of the artifact's host, outside any component. */
export function artifactSharing(id: string): Sharing {
  const hostId = artifactHost(id)
  return hostId === null ? localSharing : hostScope(hostId).sharing
}

/** Whether the artifact's host publishes pages: the desktop app does, a host without it not. */
export function useArtifactShares(id: string): boolean {
  const hostId = artifactHost(id)
  const scope = hostId === null ? LOCAL_SCOPE : hostScope(hostId)
  const known = scope.useInfoStore((s) => (s.info ? s.info.sharing : null))
  return (isWeb || hostId !== null ? known : true) === true
}

/**
 * Whether the artifact's host draws a thumbnail of one frame, slide or theme: the desktop app
 * does; another host or the web client's as it says.
 */
export function usePartThumbnails(id: string): boolean {
  const hostId = artifactHost(id)
  const scope = hostId === null ? LOCAL_SCOPE : hostScope(hostId)
  const known = scope.useInfoStore((s) => (s.info ? s.info.partThumbnails === true : null))
  return (isWeb || hostId !== null ? known : true) === true
}

/** Whether the artifact is published by its host, or null until the host has said. */
export function useArtifactPublished(id: string): boolean | null {
  return artifactSharing(id).useSharingStore((s) =>
    s.status ? s.status.published.some((page) => page.id === id) : null,
  )
}

/** Whether the artifact's host answers now: this computer's agent host, or the other host's session. */
export function useArtifactHostConnected(id: string | null): boolean {
  const hostId = id === null ? null : artifactHost(id)
  const own = useConnectionStore((s) => s.agentHost === 'connected')
  const other = useHostsStore(
    (s) =>
      hostId !== null &&
      s.status?.hosts?.find((h) => h.id === hostId)?.connection.state === 'online',
  )
  return hostId === null ? own : other
}

/**
 * Whether the artifact's host keeps `record`: the desktop app keeps every one; another host or the
 * web client's as it says, and none it has not said.
 */
export function useArtifactRecord(id: string, record: ArtifactRecord): boolean {
  const hostId = artifactHost(id)
  const scope = hostId === null ? LOCAL_SCOPE : hostScope(hostId)
  const known = scope.useInfoStore((s) => s.info?.artifactRecords?.includes(record) ?? false)
  return isWeb || hostId !== null ? known : true
}

/** Whether the artifact's host answers now, outside any component. */
function hostConnected(hostId: string | null): boolean {
  return hostId === null
    ? useConnectionStore.getState().agentHost === 'connected'
    : useHostsStore.getState().status?.hosts?.find((h) => h.id === hostId)?.connection.state ===
        'online'
}

/** Resolves once the artifact's host answers, at once when it does now. */
export function whenArtifactHostConnected(id: string): Promise<void> {
  const hostId = artifactHost(id)
  if (hostConnected(hostId)) return Promise.resolve()
  return new Promise((resolve) => {
    const check = () => {
      if (!hostConnected(hostId)) return
      offOwn()
      offOther()
      resolve()
    }
    const offOwn = useConnectionStore.subscribe(check)
    const offOther = useHostsStore.subscribe(check)
  })
}

/** The name of the computer the artifact is kept on: another host's own, or null for this one. */
export function useArtifactHostName(id: string | null): string | null {
  const hostId = id === null ? null : artifactHost(id)
  return useHostsStore((s) =>
    hostId === null ? null : (s.status?.hosts?.find((h) => h.id === hostId)?.name ?? null),
  )
}
