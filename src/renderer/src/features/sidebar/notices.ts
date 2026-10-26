import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import {
  agentUpdateLabel,
  agentUpdateNotice,
  type AgentUpdateNotice,
} from '@renderer/features/updates/agent-updates'
import {
  appUpdateNotice,
  appUpdateRow,
  type AppUpdateNotice,
} from '@renderer/features/updates/app-updates'
import { i18n } from '@renderer/lib/i18n'
import { usableAgents, useAgentsStore } from '@renderer/stores/agents'
import { useUpdatesStore } from '@renderer/stores/updates'

/** What the footer's notices show, each empty while it has nothing to say. */
export interface Notices {
  /** The agents that need sign-in, by name. */
  signIn: string[]
  agentUpdate: AgentUpdateNotice | null
  appUpdate: AppUpdateNotice | null
}

/** What the collapsed sidebar's toggle says of the notices it hides. */
export interface NoticeSummary {
  /** Each notice's words, in the footer's order. */
  labels: string[]
  /** The notices in one sentence, which lists them. */
  name: string
}

/** "Codex needs you to sign in", or how many agents do. */
export function signInLabel(names: string[]): string {
  return names.length === 1
    ? i18n.t('sidebar:footer.signInOne', { name: names[0] })
    : i18n.t('sidebar:footer.signInMany', { count: names.length })
}

/** The notices' words and their sentence; null while no notice shows. */
export function noticeSummary({ signIn, agentUpdate, appUpdate }: Notices): NoticeSummary | null {
  const labels = [
    signIn.length > 0 ? signInLabel(signIn) : null,
    agentUpdate ? agentUpdateLabel(agentUpdate) : null,
    appUpdate ? appUpdateRow(appUpdate).label : null,
  ].filter((label) => label !== null)
  if (labels.length === 0) return null
  return {
    labels,
    name: i18n.t('sidebar:footer.noticesName', {
      list: labels.join(i18n.t('sidebar:footer.listSeparator')),
    }),
  }
}

/** The sign-in and update notices, from the agents and the updater, and their summary. */
export function useNotices(): Notices & { summary: NoticeSummary | null } {
  // The labels come from i18n.t, so a language change has to render them again.
  useTranslation()
  const signIn = useAgentsStore(
    useShallow((s) =>
      s.order.filter((id) => s.byId[id]?.signIn === 'required').map((id) => s.byId[id]!.name),
    ),
  )
  const statuses = useAgentsStore(useShallow((s) => usableAgents(s.order, s.byId)))
  const status = useUpdatesStore((s) => s.status)
  const updatedSeen = useUpdatesStore((s) => s.updatedDismissed)
  const notices: Notices = {
    signIn,
    agentUpdate: agentUpdateNotice(statuses),
    appUpdate: appUpdateNotice(status, updatedSeen),
  }
  return { ...notices, summary: noticeSummary(notices) }
}
