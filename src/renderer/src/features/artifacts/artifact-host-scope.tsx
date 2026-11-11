import type { ReactNode } from 'react'
import { artifactHost } from '@renderer/lib/host'
import { HostScopeContext, hostScope, LOCAL_SCOPE } from '@renderer/stores/host-scope'

/** Shows `children` as a part of the artifact's host, so its sharing and sentences are that host's. */
export function ArtifactHostScope({ id, children }: { id: string; children: ReactNode }) {
  const hostId = artifactHost(id)
  return (
    <HostScopeContext.Provider value={hostId === null ? LOCAL_SCOPE : hostScope(hostId)}>
      {children}
    </HostScopeContext.Provider>
  )
}
