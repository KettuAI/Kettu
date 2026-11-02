import type { AgentInstallMethod, AgentStatus, AgentTask } from '@shared/agent-host'
import type { AgentId, HarnessId } from '@shared/thread'

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

/** Why a request did not run when no failed task says why, as the agents store keeps it. */
export type AgentTaskErrors = Partial<Record<AgentId, { kind: AgentTask['kind']; message: string }>>

/** An update installing now, with the lines its command printed last. */
export interface HarnessRun {
  agentId: AgentId
  harnessId: HarnessId
  name: string
  command: string
  output: string[]
}

/** An update that failed, waiting to be retried or closed. */
export interface HarnessFailure {
  agentId: AgentId
  harnessId: HarnessId
  name: string
  error: string
  retry: AgentUpdateRoute
  /** The command that ran and its last lines; null when the request failed before running. */
  command: string | null
  output: string[]
}

/** The harnesses' updates, once each through its default agent. */
export interface HarnessUpdates {
  running: HarnessRun | null
  failed: HarnessFailure | null
  /** Those on offer, apart from the running and the failed one, the skipped ones too. */
  offers: { offer: AgentUpdateOffer; skipped: boolean }[]
}

/** The harnesses' updates: one running first, then one that failed, then those on offer. */
export function harnessUpdates(
  statuses: AgentStatus[],
  taskErrors: AgentTaskErrors = {},
): HarnessUpdates {
  const defaults = statuses.filter((status) => status.isDefault)
  const busy = defaults.find((s) => s.task?.kind === 'update' && s.task.state === 'running')
  const running =
    busy?.task != null
      ? {
          agentId: busy.id,
          harnessId: busy.harnessId,
          name: busy.harnessName,
          command: busy.task.command,
          output: busy.task.progress,
        }
      : null
  let failed: HarnessFailure | null = null
  for (const status of defaults) {
    const failure = failureOf(status, taskErrors[status.id])
    if (!failure) continue
    failed = {
      agentId: status.id,
      harnessId: status.harnessId,
      name: status.harnessName,
      ...failure,
    }
    break
  }
  const offers = defaults.flatMap((status) => {
    if (status.id === running?.agentId || status.id === failed?.agentId) return []
    const offer = updateOffer(status)
    return offer ? [{ offer, skipped: status.updateSkipped }] : []
  })
  return { running, failed, offers }
}

/** The route an offered update runs; the user's program comes first, as the harness page has it. */
export function offerRoute(offer: AgentUpdateOffer): AgentUpdateRoute {
  return offer.command === null ? 'package' : 'cli'
}

function failureOf(
  status: AgentStatus,
  error: AgentTaskErrors[AgentId],
): Pick<HarnessFailure, 'error' | 'retry' | 'command' | 'output'> | null {
  const { task } = status
  if (task?.kind === 'update' && task.state === 'failed') {
    // An update with a route is the program's own.
    return {
      error: task.error ?? task.command,
      retry: task.method ? 'cli' : 'package',
      command: task.command,
      output: task.progress,
    }
  }
  if (!task && error?.kind === 'update') {
    return {
      error: error.message,
      retry: status.cli?.update ? 'cli' : 'package',
      command: null,
      output: [],
    }
  }
  return null
}

/** The update a harness offers through this agent, or null when it is up to date. */
export function updateOffer(status: AgentStatus): AgentUpdateOffer | null {
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
