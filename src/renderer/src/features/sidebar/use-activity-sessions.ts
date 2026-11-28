import { useMemo } from 'react'
import { isAway, shownHosts, useOtherHosts } from '@renderer/stores/hosts'
import { useProjectsStore } from '@renderer/stores/projects'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useViewStore } from '@renderer/stores/view'
import {
  activitySessions,
  countActivitySessions,
  type ActivityCounts,
  type ActivitySession,
} from './activity-sessions'

/**
 * Active sessions scoped to the sidebar's visible hosts (this computer plus connected remote hosts),
 * along with bucket counts and whether multiple hosts are in view.
 */
export function useActivitySessions(): {
  items: ActivitySession[]
  counts: ActivityCounts
  showHost: boolean
} {
  const byId = useSessionsStore((s) => s.byId)
  const projects = useProjectsStore((s) => s.projects)
  const others = useOtherHosts()
  const hostFilter = useViewStore((s) => s.hostFilter)
  const hostOrder = useViewStore((s) => s.hostOrder)

  const hosts = useMemo(
    () => (others.length > 0 ? shownHosts(others, hostFilter, hostOrder) : null),
    [others, hostFilter, hostOrder],
  )
  const away = useMemo(
    () => others.filter((host) => isAway(host.connection)).map((host) => host.id),
    [others],
  )
  const items = useMemo(
    () => activitySessions(byId, projects, { hosts, away }),
    [byId, projects, hosts, away],
  )
  const counts = useMemo(() => countActivitySessions(items), [items])

  return { items, counts, showHost: hosts !== null }
}
