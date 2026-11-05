// What New session's agent picker and its list of recent sessions show.

import type { AgentStatus, SessionSummary } from '@shared/agent-host'
import { tightestLimit } from '@renderer/features/sidebar/plan-usage'
import { limitLabel } from '@renderer/lib/format'
import { i18n } from '@renderer/lib/i18n'
import { agentNeed } from './start-options'

export type LineTone = 'muted' | 'attention' | 'danger'

/**
 * The line under an agent in the picker: what it needs before it can start, else its harness when
 * it is another agent on it, its account and its fullest plan limit.
 */
export function agentLine(
  status: AgentStatus,
  now = Date.now(),
): { text: string; tone: LineTone } | null {
  const need = agentNeed(status)
  if (need === 'sign-in')
    return { text: i18n.t('session:newSession.picker.signedOut'), tone: 'attention' }
  if (need === 'setup')
    return { text: i18n.t('session:newSession.agentMenu.setsUp'), tone: 'muted' }
  if (need === 'installing') {
    return { text: i18n.t('session:newSession.agentMenu.installing'), tone: 'muted' }
  }
  if (need === 'failed') return { text: i18n.t('session:newSession.picker.failed'), tone: 'danger' }
  const parts: string[] = []
  if (status.name !== status.harnessName) parts.push(status.harnessName)
  if (status.account?.label) parts.push(status.account.label)
  const limit = tightestLimit(status.limits, now)
  if (limit) {
    parts.push(
      limit.usedPercent === null
        ? i18n.t('session:newSession.picker.limitReached', { limit: limitLabel(limit) })
        : i18n.t('session:newSession.picker.limitUsed', {
            percent: Math.round(limit.usedPercent),
            limit: limitLabel(limit),
          }),
    )
  }
  return parts.length > 0 ? { text: parts.join(' · '), tone: 'muted' } : null
}

/** How many sessions Pick up where you left off lists. */
export const PICKUP = 3

/** The sessions to pick up: the user's own, outside the archive, the latest first. */
export function pickupSessions(
  byId: Readonly<Record<string, SessionSummary | undefined>>,
  count = PICKUP,
): SessionSummary[] {
  return Object.values(byId)
    .filter(
      (s): s is SessionSummary =>
        !!s && s.origin === 'user' && s.parentId === null && s.archivedAt === null && !s.prepared,
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, count)
}

export type PickupState = 'waiting' | 'working' | 'failed' | 'signIn' | 'finished'

/** What a session to pick up is doing, as its row says it. */
export function pickupState(
  session: Pick<SessionSummary, 'status' | 'attention' | 'permissionCount'>,
): PickupState {
  if (session.status === 'awaiting_permission' || session.permissionCount > 0) return 'waiting'
  if (session.status === 'running' || session.status === 'starting') return 'working'
  if (session.status === 'failed' || session.attention === 'error') return 'failed'
  if (session.status === 'auth_required') return 'signIn'
  return 'finished'
}
