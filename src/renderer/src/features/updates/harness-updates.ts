import type { SessionSummary } from '@shared/agent-host'
import { harnessOf, type AgentId } from '@shared/thread'
import { errorMessage, host } from '@renderer/lib/host'
import { useAgentsStore } from '@renderer/stores/agents'
import { hostOfSession, useSessionsStore } from '@renderer/stores/sessions'
import { useUpdatesStore } from '@renderer/stores/updates'
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
  if (!route) return
  await (route === 'cli' ? agents.updateCli(agentId) : agents.update(agentId))
}

const queue = new HarnessQueue({
  run,
  busy: (agentId) => runningSessions(agentId).length,
  watch: (onChange) =>
    useSessionsStore.subscribe((state, previous) => {
      if (state.byId !== previous.byId) onChange()
    }),
  changed: ({ waiting, queued }) =>
    useUpdatesStore.setState({ harnessWaiting: waiting, harnessQueued: queued }),
})

/** Updates harnesses one after another, each once its running sessions end. */
export function updateHarnesses(agentIds: readonly AgentId[]): void {
  queue.request(agentIds)
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
}

/** Stops the update installing, and drops those queued behind it. */
export function stopHarnessUpdate(agentId: AgentId): void {
  queue.clear()
  void useAgentsStore.getState().cancelTask(agentId)
}

/** Closes a failed update's card. */
export function closeHarnessFailure(agentId: AgentId): void {
  void useAgentsStore.getState().cancelTask(agentId)
}

/** Hides the harnesses' updates until a newer one, as closing the card does. */
export function skipHarnessUpdates(agentIds: readonly AgentId[]): void {
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
