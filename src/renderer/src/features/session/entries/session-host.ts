import { hostOfPath } from '@renderer/lib/host-paths'
import { isWeb } from '@renderer/lib/platform'
import { useOtherHost } from '@renderer/stores/hosts'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useWebHostStore } from '@renderer/stores/web-host'

/** The session's host: null for this computer, with its name when it is another one. */
export function useSessionHost(sessionId: string): { hostId: string | null; name: string | null } {
  const hostId = useSessionsStore((s) => hostOfPath(s.byId[sessionId]?.projectPath ?? ''))
  const other = useOtherHost(hostId)
  const served = useWebHostStore((s) => s.host?.name ?? null)
  if (hostId !== null) return { hostId, name: other?.name ?? null }
  // A browser reaches its host from elsewhere, so the host goes by its name there.
  return { hostId: null, name: isWeb ? served : null }
}
