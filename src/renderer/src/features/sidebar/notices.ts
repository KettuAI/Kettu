import { useShallow } from 'zustand/react/shallow'
import { updateCardLabel, type UpdateCard } from '@renderer/features/updates/card-model'
import { useUpdates } from '@renderer/features/updates/use-updates'
import { i18n } from '@renderer/lib/i18n'
import { useAgentsStore } from '@renderer/stores/agents'

/** What the footer's notices show, each empty while it has nothing to say. */
export interface Notices {
  /** The agents that need sign-in, by name. */
  signIn: string[]
  /** The one update card, for Kettu and the harnesses alike. */
  update: UpdateCard | null
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
export function noticeSummary({ signIn, update }: Notices): NoticeSummary | null {
  const labels = [
    signIn.length > 0 ? signInLabel(signIn) : null,
    update ? updateCardLabel(update) : null,
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
  const signIn = useAgentsStore(
    useShallow((s) =>
      s.order
        .filter(
          (id) =>
            s.byId[id]?.registered !== false &&
            !s.byId[id]?.disabled &&
            s.byId[id]?.signIn === 'required',
        )
        .map((id) => s.byId[id]!.name),
    ),
  )
  const notices: Notices = { signIn, update: useUpdates().card }
  return { ...notices, summary: noticeSummary(notices) }
}
