import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { usableAgents, useAgentsStore } from '@renderer/stores/agents'
import { localHarnessCounts, useSessionsStore } from '@renderer/stores/sessions'
import { useUpdatesStore } from '@renderer/stores/updates'
import { appUpdateNotice } from './app-updates'
import { updateBatch, updateCard, updateItems, type UpdatesInput } from './card-model'

const NO_SESSIONS: UpdatesInput['sessions'] = []

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
  const installing = useUpdatesStore((s) => s.harnessInstalling)
  const batch = useUpdatesStore((s) => s.harnessBatch)
  // Harness updates are this computer's, so only its per-harness counts matter.
  const sessionCounts = useSessionsStore(useShallow((s) => localHarnessCounts(s.byId)))
  const input: UpdatesInput = {
    app: appUpdateNotice(status, updatedSeen),
    statuses,
    taskErrors,
    sessions: NO_SESSIONS,
    sessionCounts,
    waiting,
    queued,
    installing,
    batch,
  }
  return {
    input,
    card: updateCard(input),
    items: updateItems(input),
    batch: updateBatch(input),
  }
}
