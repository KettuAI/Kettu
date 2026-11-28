// State of the updater in main, as every surface reads it.

import type { BusySession } from './host-control'
import type { Locale } from './locale'

export type UpdateState =
  | { kind: 'off'; reason: 'development' | 'unsupported' }
  | { kind: 'idle'; checkedAt: number | null } // up to date, or not checked yet
  | { kind: 'checking'; manual: boolean }
  | { kind: 'available'; version: string; mode: 'install' | 'link' } // found, not downloading
  | { kind: 'moving'; version: string } // Update on a read-only volume, moving the app first
  // manual: Update. replaces: the downloaded version a newer one replaces, whose notice stays up.
  | {
      kind: 'downloading'
      version: string
      percent: number
      manual: boolean
      replaces?: string
    }
  // Downloaded and verified; notes: the release's highlights in each language it has them in.
  | { kind: 'ready'; version: string; notes?: Partial<Record<Locale, string[]>> }
  // move: the move failed; githubUnreachable: GitHub, the only source, could not be reached.
  | { kind: 'error'; message: string; manual: boolean; move?: true; githubUnreachable?: true }

export type UpdateConfirmationAction = 'now' | 'whenIdle' | 'cancel'

export type UpdatePhase =
  | 'off'
  | 'idle'
  | 'checking'
  | 'available'
  | 'moving'
  | 'accepted'
  | 'downloading'
  | 'ready'
  | 'awaiting_confirmation'
  | 'waiting_for_idle'
  | 'awaiting_host_confirmation'
  | 'restarting'
  | 'cancelled'
  | 'failed'

export interface UpdateInitiator {
  kind: 'local' | 'remote'
  /** Paired device id when initiated remotely; null for local desktop triggers. */
  deviceId: string | null
  /** Human-readable paired device name when initiated remotely; null for local triggers. */
  deviceName: string | null
}

export interface UpdateBusySummary {
  /** Total busy sessions (active turns, subagents, and background tasks). */
  sessions: number
  /** Working sessions that `whenIdle` can wait for (active turns and subagents). */
  waitableSessions: number
  /** Busy terminals with a foreground command running. */
  terminals: number
  /** Desktop editor files with unsaved changes. */
  unsavedFiles: number
}

export interface UpdateConfirmationRequest {
  /** Unique identifier of this pending update timing confirmation. */
  requestId: string
  /** Target version being installed or moved, if known. */
  version: string | null
  /** Who initiated this update request; only this initiator (while still authorized) or desktop may answer. */
  initiator: UpdateInitiator
  /** Summary of running work blocking an immediate unattended restart. */
  busy: UpdateBusySummary
  /** Allowed timing choices for this request (`whenIdle` included only when waitable work exists and no unsaved files block it). */
  choices: UpdateConfirmationAction[]
  /** Epoch milliseconds when confirmation was requested. */
  requestedAt: number
}

export interface UpdateHostConfirmation {
  /** Host platform requiring a native OS confirmation dialog. */
  platform: 'win32' | 'darwin'
  /** Native prompt type: Windows UAC/SmartScreen or macOS Applications move authorization. */
  kind: 'windows_system' | 'macos_authorization'
  /** Target version being installed or moved, if known. */
  version: string | null
  /** Who initiated the update that triggered native host confirmation. */
  initiator: UpdateInitiator
  /** Epoch milliseconds when native host confirmation started. */
  startedAt: number
}

export type UpdateOutcomeCode =
  | 'user_cancelled'
  | 'initiator_disconnected'
  | 'permission_revoked'
  | 'download_failed'
  | 'check_failed'
  | 'move_failed'
  | 'host_confirmation_cancelled'
  | 'host_confirmation_failed'
  | 'install_failed'
  | 'restart_failed'
  | 'unsupported'
  | 'unknown'

export interface UpdateOutcome {
  kind: 'cancelled' | 'failed'
  /** Machine-readable reason code. */
  code: UpdateOutcomeCode
  /** Human-readable detail, if available. */
  message?: string
  /** Request id settled by this outcome, if any. */
  requestId?: string | null
  /** Source of the settlement. */
  by?: 'local' | 'remote' | 'host' | 'system'
  /** Epoch milliseconds when this outcome was recorded. */
  at: number
}

export interface UpdateStatus {
  state: UpdateState
  mode: 'install' | 'link' // how this build updates, even while updates are off
  readOnly: boolean // on a read-only volume, which only macOS Install mode tests
  current: string // the running version
  updatedFrom: string | null // set for the first launch after an update
  dismissed: string | null // the version whose notice was dismissed
  /** Set while the restart into the update waits for working sessions or running terminal commands to finish. */
  restartWhenIdle: { sessions: number; terminals?: number } | null
  /**
   * Unified lifecycle phase across checking, download, timing confirmation, waiting for idle,
   * native Windows/macOS host confirmation, restart, cancellation, and failure. Absent only from
   * older hosts.
   */
  phase?: UpdatePhase
  /** Active or most recently settled update/restart request id. */
  requestId?: string | null
  /** Who initiated the active or most recent update operation. */
  initiator?: UpdateInitiator | null
  /** Present while waiting for a timing decision (`phase === 'awaiting_confirmation'`). */
  confirmation?: UpdateConfirmationRequest | null
  /** Present while waiting for a native OS prompt on the host (`phase === 'awaiting_host_confirmation'`). */
  hostConfirmation?: UpdateHostConfirmation | null
  /** Present when an update or restart operation ended in cancellation or failure. */
  outcome?: UpdateOutcome | null
  /** Download progress percentage (0-100) while downloading, null otherwise. */
  progress?: number | null
}

export const LOCAL_UPDATE_INITIATOR: UpdateInitiator = {
  kind: 'local',
  deviceId: null,
  deviceName: null,
}

export function isUpdateConfirmationAction(value: unknown): value is UpdateConfirmationAction {
  return value === 'now' || value === 'whenIdle' || value === 'cancel'
}

/**
 * Timing choices allowed when running work blocks an immediate restart. `whenIdle` is offered
 * when at least one working session or busy terminal can finish on its own and no unsaved desktop
 * files would be lost.
 */
export function updateConfirmationChoices(busy: UpdateBusySummary): UpdateConfirmationAction[] {
  const canWait = busy.unsavedFiles === 0 && (busy.waitableSessions > 0 || busy.terminals > 0)
  return canWait ? ['now', 'whenIdle', 'cancel'] : ['now', 'cancel']
}

/**
 * Whether a restart to update can wait for this working session: its turn and its subagents end
 * by themselves, unlike background commands and scheduled wakeups.
 */
export function restartWaitsFor(session: BusySession): boolean {
  return session.turnStartedAt !== null || (session.background?.subagents.length ?? 0) > 0
}

export const RELEASES_URL = 'https://github.com/KettuAI/Kettu/releases'

export function releaseUrl(version: string): string {
  return `${RELEASES_URL}/tag/v${version}`
}
