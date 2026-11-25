// What the Agent page, the sidebar and New session's agent menu say of when a subscription
// sign-in ends.

import type { AgentStatus } from '@shared/agent-host'
import { signInEnd, type SignInEnd } from '@shared/sign-in-end'
import { daysBefore, monthDay } from '@renderer/lib/format'
import { i18n } from '@renderer/lib/i18n'

/** When the agent's subscription sign-in ends, for an agent that is on and reports one. */
export function agentSignInEnd(status: AgentStatus, now: number): SignInEnd | null {
  const ends = status.account?.kind === 'account' ? status.account.signInEnds : undefined
  if (ends === undefined || status.disabled || status.registered === false) return null
  return signInEnd(ends, now)
}

/** Calendar days from `now` to `at`: 0 the same day. */
const daysTo = (at: number, now: number): number => daysBefore(now, at)

const dates = (end: SignInEnd) => ({
  latest: monthDay(end.latest),
  earliest: monthDay(end.earliest),
})

/** The Agent page's value: "By Dec 2 (as early as Nov 29) · 4–7 days left", or "Probably ended". */
export function signInEndValue(end: SignInEnd, now: number): string {
  const t = i18n.t.bind(i18n)
  if (end.phase === 'ended') return t('settings:agents.signInEnds.ended')
  const from = daysTo(end.earliest, now)
  const to = daysTo(end.latest, now)
  if (from >= 1) return t('settings:agents.signInEnds.days', { ...dates(end), from, to })
  if (to >= 1) return t('settings:agents.signInEnds.atMost', { ...dates(end), count: to })
  return t('settings:agents.signInEnds.today', dates(end))
}

/** The sidebar card's line, with the agent's name. */
export function signInEndNotice(name: string, end: SignInEnd, now: number): string {
  const t = i18n.t.bind(i18n)
  if (end.phase === 'ended') return t('sidebar:signInEnds.ended', { name })
  const days = daysTo(end.earliest, now)
  return days >= 1
    ? t('sidebar:signInEnds.inDays', { name, count: days })
    : t('sidebar:signInEnds.anyDay', { name })
}

/** The whole sentence, with both dates, that the card and the menu's tag show on hover. */
export function signInEndSentence(end: SignInEnd): string {
  return i18n.t(
    end.phase === 'ended' ? 'sidebar:signInEnds.endedDetail' : 'sidebar:signInEnds.detail',
    dates(end),
  )
}
