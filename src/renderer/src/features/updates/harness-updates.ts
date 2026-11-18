import type { SessionSummary } from '@shared/agent-host'
import { harnessOf, type AgentId } from '@shared/thread'
import { errorMessage, host } from '@renderer/lib/host'
import { useAgentsStore } from '@renderer/stores/agents'
import { hostOfSession, useSessionsStore } from '@renderer/stores/sessions'
import { useUpdatesStore, type HarnessBatchEntry } from '@renderer/stores/updates'
import { offerRoute, updateOffer, type AgentUpdateRoute } from './agent-updates'
import { HarnessQueue } from './harness-queue'

/** This computer's sessions of the agent's harness with a turn running now. */
export function runningSessions(agentId: AgentId): SessionSummary[] {
  const harness = harnessOf(agentId)
  return Object.values(useSessionsStore.getState().byId).filter(
    (s) =>
      hostOfSession(s) === null &&
      harnessOf(s.agentId) === harness &&
      (s.status === 'running' || s.status === 'awaiting_permission'),
  )
}

/** The route a retry takes, which a failed update names, by agent. */
const retries = new Map<AgentId, AgentUpdateRoute>()

async function run(agentId: AgentId): Promise<void> {
  const agents = useAgentsStore.getState()
  const status = agents.byId[agentId]
  const offer = status ? updateOffer(status) : null
  const route = retries.get(agentId) ?? (offer ? offerRoute(offer) : null)
  retries.delete(agentId)
  // Gone by its turn, as when it installed another way meanwhile.
  if (route) await (route === 'cli' ? agents.updateCli(agentId) : agents.update(agentId))
  settleBatchEntry(agentId)
}

function setBatch(change: (batch: HarnessBatchEntry[]) => HarnessBatchEntry[]): void {
  useUpdatesStore.setState((state) => ({ harnessBatch: change(state.harnessBatch) }))
}

/**
 * Records how an update of the batch ended. One still on offer at the same version was stopped,
 * so it leaves the batch and is on offer again.
 */
function settleBatchEntry(agentId: AgentId): void {
  const { byId, taskErrors } = useAgentsStore.getState()
  const status = byId[agentId]
  const failed =
    (status?.task?.kind === 'update' && status.task.state === 'failed') ||
    taskErrors[agentId]?.kind === 'update'
  const offer = status ? updateOffer(status) : null
  setBatch((batch) => {
    const entry = batch.find((e) => e.agentId === agentId)
    if (!entry) return batch
    if (!failed && offer?.to === entry.to) return batch.filter((e) => e !== entry)
    return batch.map((e) => (e === entry ? { ...e, ended: failed ? 'failed' : 'updated' } : e))
  })
}

const queue = new HarnessQueue({
  run,
  busy: (agentId) => runningSessions(agentId).length,
  watch: (onChange) =>
    useSessionsStore.subscribe((state, previous) => {
      if (state.byId !== previous.byId) onChange()
    }),
  changed: ({ waiting, queued, installing }) =>
    useUpdatesStore.setState({
      harnessWaiting: waiting,
      harnessQueued: queued,
      harnessInstalling: installing,
    }),
})

/**
 * Updates harnesses one after another, each once its running sessions end, as one batch the card
 * follows: a batch that already ended gives way to the new one.
 */
export function updateHarnesses(agentIds: readonly AgentId[]): void {
  const { byId } = useAgentsStore.getState()
  setBatch((batch) => {
    const next = batch.some((e) => e.ended === null) ? [...batch] : []
    for (const agentId of agentIds) {
      const status = byId[agentId]
      const offer = status ? updateOffer(status) : null
      const at = next.findIndex((e) => e.agentId === agentId)
      const entry: HarnessBatchEntry | null = offer
        ? { agentId, name: offer.name, from: offer.from, to: offer.to, ended: null }
        : at >= 0
          ? { ...next[at]!, ended: null }
          : null
      if (!entry) continue
      if (at >= 0) next[at] = entry
      else next.push(entry)
    }
    return next
  })
  queue.request(agentIds)
}

/** Clears the batch the card followed, once it showed how it ended. */
export function endHarnessBatch(): void {
  setBatch(() => [])
}

/**
 * Stops the batch: the update installing stops, those queued and waiting are on offer again,
 * and those already installed stay.
 */
export function stopHarnessBatch(): void {
  const { harnessWaiting, harnessInstalling } = useUpdatesStore.getState()
  for (const agentId of harnessWaiting) queue.forget(agentId)
  queue.clear()
  endHarnessBatch()
  if (harnessInstalling) void useAgentsStore.getState().cancelTask(harnessInstalling)
}

/** Retries a failed update the way it ran. */
export function retryHarnessUpdate(agentId: AgentId, route: AgentUpdateRoute): void {
  retries.set(agentId, route)
  updateHarnesses([agentId])
}

/** Stops the harness's running sessions, then updates it at once. */
export async function updateHarnessNow(agentId: AgentId): Promise<void> {
  await Promise.all(
    runningSessions(agentId).map((s) =>
      host('sessions.cancel', { sessionId: s.id }).catch((error: unknown) =>
        console.warn(`Could not stop a session: ${errorMessage(error)}`),
      ),
    ),
  )
  queue.request([agentId], { now: true })
}

/** Stops waiting for an update, which is on offer again. */
export function forgetHarnessUpdate(agentId: AgentId): void {
  queue.forget(agentId)
  setBatch((batch) => batch.filter((e) => e.agentId !== agentId))
}

/** Stops the update installing, and drops those queued behind it. */
export function stopHarnessUpdate(agentId: AgentId): void {
  queue.clear()
  void useAgentsStore.getState().cancelTask(agentId)
}

/** Closes a failed update's card, which ends the batch it failed in. */
export function closeHarnessFailure(agentId: AgentId): void {
  endHarnessBatch()
  void useAgentsStore.getState().cancelTask(agentId)
}

/** Hides the harnesses' updates until a newer one, as closing the card does. */
export function skipHarnessUpdates(agentIds: readonly AgentId[]): void {
  setBatch((batch) => batch.filter((e) => !agentIds.includes(e.agentId)))
  for (const agentId of agentIds) {
    queue.forget(agentId)
    void host('agents.skipUpdate', { agentId }).catch((error: unknown) =>
      console.warn(`Could not skip the agent update: ${errorMessage(error)}`),
    )
  }
}

/** Offers a skipped update again. */
export function unskipHarnessUpdate(agentId: AgentId): void {
  void host('agents.unskipUpdate', { agentId }).catch((error: unknown) =>
    console.warn(`Could not offer the agent update again: ${errorMessage(error)}`),
  )
}
