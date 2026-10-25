import type { AgentStatus } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'

/** The agents whose update the footer's notice shows, and what it names for one. */
export type AgentUpdateNotice =
  | { kind: 'one'; agentId: AgentId; name: string; version: string }
  | { kind: 'many'; agentIds: AgentId[] }

/**
 * The agents with an update to show: offered, not skipped, and not installing. The version is the
 * CLI's when the update brings one, else the adapter's.
 */
export function agentUpdateNotice(statuses: AgentStatus[]): AgentUpdateNotice | null {
  const shown: { agentId: AgentId; name: string; version: string }[] = []
  for (const status of statuses) {
    const { update, task } = status
    if (!update || status.updateSkipped) continue
    if (task?.kind === 'update' && task.state === 'running') continue
    shown.push({
      agentId: status.id,
      name: status.name,
      version: update.cliVersion ?? update.adapterVersion,
    })
  }
  if (shown.length === 0) return null
  if (shown.length === 1) return { kind: 'one', ...shown[0]! }
  return { kind: 'many', agentIds: shown.map((agent) => agent.agentId) }
}
