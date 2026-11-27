import type { SessionStatus } from '@shared/thread'

export interface ComposerRunInput {
  status: SessionStatus
  waitingBackground?: boolean
  heldOutside?: boolean
}

export interface ComposerRunState {
  starting: boolean
  /** Underlying prompt is held open only for background work; composer presents as idle. */
  waitingBackground: boolean
  /** Main turn is actively running or waiting on user approval/questions. */
  activeRunning: boolean
  awaiting: boolean
  idle: boolean
  /** Whether pressing Escape cancels the turn (false while idle-waiting on background tasks). */
  escapeCancels: boolean
  /** Whether an empty composer shows the Stop button instead of a disabled Send button. */
  showStopWhenEmpty: boolean
}

/**
 * Derives the composer's interaction mode from session status and `waitingBackground`, ensuring
 * idle background wait matches Claude Code's stopped composer (idle placeholder, disabled Send
 * when empty, no accidental Esc cancellation, and immediate follow-up delivery).
 */
export function composerRunState({
  status,
  waitingBackground: rawWaiting,
  heldOutside = false,
}: ComposerRunInput): ComposerRunState {
  const starting = status === 'starting'
  const waitingBackground = status === 'running' && rawWaiting === true
  const activeRunning =
    (status === 'running' && !waitingBackground) || status === 'awaiting_permission'
  const awaiting = status === 'awaiting_permission'
  const idle = (status === 'ready' || status === 'closed') && !heldOutside
  return {
    starting,
    waitingBackground,
    activeRunning,
    awaiting,
    idle,
    escapeCancels: activeRunning,
    showStopWhenEmpty: activeRunning,
  }
}
