import { useShallow } from 'zustand/react/shallow'
import type { AgentStatus } from '@shared/agent-host'
import type { SignInEnd } from '@shared/sign-in-end'
import { agentSignInEnd, signInEndNotice } from '@renderer/features/agents/sign-in-end'
import { updateCardLabel, type UpdateCard } from '@renderer/features/updates/card-model'
import { useUpdates } from '@renderer/features/updates/use-updates'
import { i18n } from '@renderer/lib/i18n'
import { useClock } from '@renderer/lib/use-now'
import { useAgentsStore } from '@renderer/stores/agents'
import { dismissalOf, useSignInEndNotice } from '@renderer/stores/sign-in-end-notice'

/** An agent whose sign-in ends soon or probably ended, and what its card says. */
export interface SignInEndCard {
  status: AgentStatus
  end: SignInEnd
  text: string
}

/** What the footer's notices show, each empty while it has nothing to say. */
export interface Notices {
  /** The agents that need sign-in, by name. */
  signIn: string[]
  /** The sign-in that ends first, of those that end soon or probably ended and are not dismissed. */
  signInEnd: SignInEndCard | null
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
export function noticeSummary({ signIn, signInEnd, update }: Notices): NoticeSummary | null {
  const labels = [
    signIn.length > 0 ? signInLabel(signIn) : null,
    signInEnd?.text ?? null,
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

const MINUTE = 60_000

/** The card of the sign-in that ends first, skipping those dismissed for this date and phase. */
function firstSignInEnd(
  statuses: readonly AgentStatus[],
  now: number,
  dismissed: readonly string[],
): SignInEndCard | null {
  let first: { status: AgentStatus; end: SignInEnd } | null = null
  for (const status of statuses) {
    const end = agentSignInEnd(status, now)
    if (!end || end.phase === 'later') continue
    if (dismissed.includes(dismissalOf(status.id, end.latest, end.phase))) continue
    if (!first || end.latest < first.end.latest) first = { status, end }
  }
  return first && { ...first, text: signInEndNotice(first.status.name, first.end, now) }
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
  // An agent that needs sign-in already has its card.
  const ending = useAgentsStore(
    useShallow((s) =>
      s.order.flatMap((id) => {
        const status = s.byId[id]
        return status?.account?.signInEnds !== undefined && status.signIn !== 'required'
          ? [status]
          : []
      }),
    ),
  )
  const dismissed = useSignInEndNotice((s) => s.dismissed)
  // The phases and days change by the day, so the minute is enough.
  const now = useClock((at) => Math.floor(at / MINUTE)) * MINUTE
  const notices: Notices = {
    signIn,
    signInEnd: firstSignInEnd(ending, now, dismissed),
    update: useUpdates().card,
  }
  return { ...notices, summary: noticeSummary(notices) }
}
