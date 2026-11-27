import type { ThreadState } from '@shared/thread'
import { inLatestTurn } from '../turn-phase'

/**
 * Whether a post-update recovery warning notice should offer the one-click manual Continue button:
 * only for top-level user sessions that are currently idle and have not started a newer turn.
 */
export function canManualResumeUpdate(
  state: ThreadState | null | undefined,
  entryId: string,
): boolean {
  if (!state || state.session.origin !== 'user') return false
  const { status } = state.session
  return (status === 'ready' || status === 'closed') && inLatestTurn(state, entryId)
}
