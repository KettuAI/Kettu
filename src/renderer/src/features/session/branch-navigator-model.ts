import type { AgentStatus, SessionBranchesResult, SessionSummary } from '@shared/agent-host'
import type { SessionView } from '@shared/thread'
import { hostAt } from '@renderer/lib/host'
import { hostOfSession } from '@renderer/stores/sessions'

export type BranchSwitchBlockReason = 'running' | 'starting' | 'rewound' | 'archived'

/** Native session branches are shown only for non-subagent sessions whose harness advertises them. */
export function supportsNativeBranches(
  agent: Pick<AgentStatus, 'capabilities'> | undefined,
  summary: Pick<SessionSummary, 'origin'>,
): boolean {
  return agent?.capabilities.branches === true && summary.origin !== 'subagent'
}

/**
 * Why switching branches is currently blocked for this session, or null when switching is allowed.
 * Mirrors the host-side checks in `SessionManager.switchBranch`.
 */
export function branchSwitchBlockReason(
  session: Pick<SessionView, 'status' | 'waitingBackground' | 'rewound'> | undefined,
  summary: Pick<SessionSummary, 'status' | 'phase'>,
  archived: boolean,
): BranchSwitchBlockReason | null {
  if (archived) return 'archived'
  if (session?.rewound) return 'rewound'
  const status = session?.status ?? summary.status
  if (status === 'starting') return 'starting'
  const waitingBackground =
    status === 'running' &&
    (session ? session.waitingBackground === true : summary.phase === 'waiting_background')
  if ((status === 'running' && !waitingBackground) || status === 'awaiting_permission') {
    return 'running'
  }
  return null
}

/** Fetches the native branch tree for a session from its owning host (local or remote). */
export function fetchSessionBranches(
  summary: Pick<SessionSummary, 'id' | 'projectPath'>,
): Promise<SessionBranchesResult> {
  return hostAt(hostOfSession(summary), 'sessions.branches', { sessionId: summary.id })
}

/** Switches the session's native branch on its owning host, syncing history and next-turn context. */
export function switchSessionBranch(
  summary: Pick<SessionSummary, 'id' | 'projectPath'>,
  branchId: string,
): Promise<SessionBranchesResult> {
  return hostAt(hostOfSession(summary), 'sessions.switchBranch', {
    sessionId: summary.id,
    branchId,
  })
}

/** Formats a branch segment timestamp concisely (time only for today, short date + time earlier). */
export function formatBranchTime(
  timestamp: number | null,
  locale: string,
  now = Date.now(),
): string | null {
  if (timestamp === null || !Number.isFinite(timestamp)) return null
  const date = new Date(timestamp)
  const current = new Date(now)
  const sameDay =
    date.getFullYear() === current.getFullYear() &&
    date.getMonth() === current.getMonth() &&
    date.getDate() === current.getDate()
  try {
    return sameDay
      ? new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(date)
      : new Intl.DateTimeFormat(locale, {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        }).format(date)
  } catch {
    return date.toISOString().slice(11, 16)
  }
}
