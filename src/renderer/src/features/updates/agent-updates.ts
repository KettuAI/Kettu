import type { AgentInstallMethod, AgentStatus, AgentTask } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import { i18n } from '@renderer/lib/i18n'

/** One harness's update on offer, as the card and its popover name it. */
export interface AgentUpdateOffer {
  agentId: AgentId
  name: string
  /** The version that runs now; null when unknown. */
  from: string | null
  to: string
  /** The command that updates the user's own program; null when Kettu updates its package. */
  command: string | null
  /** How the user installed their program, which the command follows. */
  method: AgentInstallMethod['id'] | null
  /** Kettu's package the update installs; `versions` when `from` and `to` are its own. */
  package: { name: string; versions: boolean } | null
}

/** How an update runs: the user's program's own command, or Kettu installing its package. */
export type AgentUpdateRoute = 'cli' | 'package'

/** What the agent update card shows: an update running, one that failed, or those on offer. */
export type AgentUpdateNotice =
  | { kind: 'one'; offer: AgentUpdateOffer }
  | { kind: 'many'; offers: AgentUpdateOffer[] }
  | { kind: 'running'; agentId: AgentId; name: string; command: string }
  | { kind: 'failed'; agentId: AgentId; name: string; error: string; retry: AgentUpdateRoute }

/** Why a request did not run when no failed task says why, as the agents store keeps it. */
export type AgentTaskErrors = Partial<Record<AgentId, { kind: AgentTask['kind']; message: string }>>

/**
 * The card for the harnesses' updates, once each through its default agent: an update running
 * first, then one that failed, then those on offer that the user has not skipped.
 */
export function agentUpdateNotice(
  statuses: AgentStatus[],
  taskErrors: AgentTaskErrors = {},
): AgentUpdateNotice | null {
  const defaults = statuses.filter((status) => status.isDefault)
  const running = defaults.find((s) => s.task?.kind === 'update' && s.task.state === 'running')
  if (running?.task) {
    return {
      kind: 'running',
      agentId: running.id,
      name: running.harnessName,
      command: running.task.command,
    }
  }
  for (const status of defaults) {
    const failed = failure(status, taskErrors[status.id])
    if (failed) return { kind: 'failed', agentId: status.id, name: status.harnessName, ...failed }
  }
  const offers = defaults.flatMap((status) => {
    const offer = status.updateSkipped ? null : updateOffer(status)
    return offer ? [offer] : []
  })
  if (offers.length === 0) return null
  if (offers.length === 1) return { kind: 'one', offer: offers[0]! }
  return { kind: 'many', offers }
}

/** The route an offered update runs; the user's program comes first, as the harness page has it. */
export function offerRoute(offer: AgentUpdateOffer): AgentUpdateRoute {
  return offer.command === null ? 'package' : 'cli'
}

function failure(
  status: AgentStatus,
  error: AgentTaskErrors[AgentId],
): { error: string; retry: AgentUpdateRoute } | null {
  const { task } = status
  if (task?.kind === 'update' && task.state === 'failed') {
    // An update with a route is the program's own.
    return { error: task.error ?? task.command, retry: task.method ? 'cli' : 'package' }
  }
  if (!task && error?.kind === 'update') {
    return { error: error.message, retry: status.cli?.update ? 'cli' : 'package' }
  }
  return null
}

function updateOffer(status: AgentStatus): AgentUpdateOffer | null {
  const base = { agentId: status.id, name: status.harnessName }
  const cli = status.cli
  if (cli?.update) {
    return {
      ...base,
      from: cli.installed?.version ?? null,
      to: cli.update.version,
      command: cli.update.command,
      method: cli.method,
      package: null,
    }
  }
  const { update } = status
  if (!update || !status.package) return null
  const current = cli ? (cli.installed?.version ?? null) : status.version
  // An update that brings no newer agent changes only the package, so it names the package's
  // versions.
  const agent = update.cliVersion !== null && update.cliVersion !== current
  return {
    ...base,
    from: agent ? current : status.package.version,
    to: agent ? update.cliVersion! : update.adapterVersion,
    command: null,
    method: null,
    package: { name: status.package.name, versions: !agent },
  }
}

/** The card's words as one string, its name: "Claude Code can be updated to 2.1.316". */
export function agentUpdateLabel(notice: AgentUpdateNotice): string {
  switch (notice.kind) {
    case 'one':
      return i18n.t('updates:agentNotice.oneLabel', {
        name: notice.offer.name,
        version: notice.offer.to,
      })
    case 'many':
      return `${i18n.t('updates:agentNotice.many')} ${notice.offers.length}`
    case 'running':
      return i18n.t('updates:agentNotice.running', { name: notice.name })
    case 'failed':
      return i18n.t('updates:agentNotice.failed', { name: notice.name })
  }
}
