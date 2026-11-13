import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { SessionSummary } from '@shared/agent-host'
import { usableAgents, useAgentsStore } from '@renderer/stores/agents'
import { hostOfSession, useSessionsStore } from '@renderer/stores/sessions'
import { useUpdatesStore } from '@renderer/stores/updates'
import { appUpdateNotice } from './app-updates'
import { updateCard, updateItems, type UpdatesInput } from './card-model'

/** What the update card and its review list show, from the updater, the agents and the sessions. */
export function useUpdates() {
  // The words come from i18n.t, so a language change has to render them again.
  useTranslation()
  const statuses = useAgentsStore(useShallow((s) => usableAgents(s.order, s.byId)))
  const taskErrors = useAgentsStore((s) => s.taskErrors)
  const status = useUpdatesStore((s) => s.status)
  const updatedSeen = useUpdatesStore((s) => s.updatedDismissed)
  const waiting = useUpdatesStore((s) => s.harnessWaiting)
  const queued = useUpdatesStore((s) => s.harnessQueued)
  // Harness updates are this computer's, so only its sessions hold them.
  const sessions = useSessionsStore(
    useShallow((s) =>
      Object.values(s.byId)
        .filter((summary) => hostOfSession(summary) === null)
        .map((summary) => agentStatus(summary.agentId, summary.status)),
    ),
  )
  const input: UpdatesInput = {
    app: appUpdateNotice(status, updatedSeen),
    statuses,
    taskErrors,
    sessions,
    waiting,
    queued,
  }
  return { input, card: updateCard(input), items: updateItems(input) }
}

type AgentStatusPair = Pick<SessionSummary, 'agentId' | 'status'>
const pairs = new Map<string, AgentStatusPair>()

/**
 * One object per agent and status, so the list compares equal while no session's agent or status
 * changes, whatever else in its summary does.
 */
function agentStatus(agentId: SessionSummary['agentId'], status: SessionSummary['status']) {
  const key = `${agentId}\n${status}`
  let pair = pairs.get(key)
  if (!pair) pairs.set(key, (pair = { agentId, status }))
  return pair
}
