import type { AgentStatus } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import { i18n } from '@renderer/lib/i18n'

/** The agents whose update the notice shows, and what it names for one. */
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

/** The notice's first line as one string: "Claude Code update 2.1.310", "Agent updates 2". */
export function agentUpdateLabel(notice: AgentUpdateNotice): string {
  return notice.kind === 'one'
    ? `${i18n.t('updates:agentNotice.one', { name: notice.name })} ${notice.version}`
    : `${i18n.t('updates:agentNotice.many')} ${notice.agentIds.length}`
}
