import type { AgentStatus, AgentTask } from '@shared/agent-host'
import type { AgentId, HarnessId } from '@shared/thread'
import { updateOffer, type AgentUpdateOffer } from '@shared/agent-update-offer'

export { updateOffer, type AgentUpdateOffer }

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
  /** Every failed update, the first being `failed`. */
  failures: HarnessFailure[]
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
  const failures: HarnessFailure[] = []
  for (const status of defaults) {
    const failure = failureOf(status, taskErrors[status.id])
    if (!failure) continue
    failures.push({
      agentId: status.id,
      harnessId: status.harnessId,
      name: status.harnessName,
      ...failure,
    })
  }
  const failed = failures[0] ?? null
  const offers = defaults.flatMap((status) => {
    if (status.id === running?.agentId || status.id === failed?.agentId) return []
    const offer = updateOffer(status)
    return offer ? [{ offer, skipped: status.updateSkipped }] : []
  })
  return { running, failed, failures, offers }
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
