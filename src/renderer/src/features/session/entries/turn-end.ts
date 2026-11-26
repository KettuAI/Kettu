import type { StopReason } from '@shared/thread'
import { duration, fullTime, turnDuration } from '@renderer/lib/format'
import { i18n } from '@renderer/lib/i18n'

export interface CompletedTurnDuration {
  label: string
  title: string
}

export function stopReasonText(stopReason: StopReason, durationMs: number): string {
  switch (stopReason) {
    case 'end_turn':
      return i18n.t('session:stopReason.endTurn', {
        duration: turnDuration(durationMs) ?? duration(durationMs),
      })
    case 'cancelled':
      return i18n.t('session:stopReason.cancelled')
    case 'max_tokens':
      return i18n.t('session:stopReason.maxTokens')
    case 'max_turn_requests':
      return i18n.t('session:stopReason.maxTurnRequests')
    case 'refusal':
      return i18n.t('session:stopReason.refusal')
  }
}

/**
 * Duration metadata shown in a completed reply's footer. Returns null for legacy turns without a
 * recorded duration, non-positive/invalid durations, or abnormal stop reasons (which render their
 * own TurnEndTag row above the footer).
 */
export function completedTurnDuration(
  end: { stopReason: StopReason; durationMs?: number | null } | null | undefined,
  completedAt?: number,
): CompletedTurnDuration | null {
  if (!end || end.stopReason !== 'end_turn') return null
  const formatted = turnDuration(end.durationMs)
  if (formatted === null) return null
  const label = i18n.t('session:stopReason.endTurn', { duration: formatted })
  const title =
    typeof completedAt === 'number' && Number.isFinite(completedAt)
      ? i18n.t('session:replyFooter.durationTitleWithTime', {
          duration: label,
          time: fullTime(completedAt),
        })
      : label
  return { label, title }
}

/**
 * Text for a TurnEndTag or standalone TurnEndEntry. Normal endings omit invalid or non-positive
 * durations; abnormal endings always keep their stop reason and append elapsed time past a second.
 */
export function turnEndTagText(
  stopReason: StopReason,
  durationMs: number | null | undefined,
): string | null {
  if (stopReason === 'end_turn') {
    const formatted = turnDuration(durationMs)
    return formatted === null ? null : i18n.t('session:stopReason.endTurn', { duration: formatted })
  }
  const reason = stopReasonText(stopReason, 0)
  if (typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 1000) {
    const formatted = turnDuration(durationMs)
    if (formatted !== null) {
      return i18n.t('session:stopReason.withTime', { reason, time: formatted })
    }
  }
  return reason
}
