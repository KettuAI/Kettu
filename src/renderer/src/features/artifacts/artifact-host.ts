// The host an artifact is kept on, for the parts that show it: its sharing, what it offers and
// whether it is reached. An artifact of this computer's takes the window's own.

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
