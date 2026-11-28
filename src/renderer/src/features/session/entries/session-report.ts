import { useShallow } from 'zustand/react/shallow'
import type { FromSessionEnded } from '@shared/thread'
import { clockTime, daysBefore, fullTime, monthDayTime } from '@renderer/lib/format'
import { i18n } from '@renderer/lib/i18n'
import { revealMessage } from '@renderer/stores/reveal'
import { sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import { openSession } from '@renderer/stores/view'
import { stopReasonText } from './turn-end'

/** The session a message or report came from, while Kettu still holds it. */
export function useSender(sessionId: string) {
  return useSessionsStore(
    useShallow((s) => {
      const sender = s.byId[sessionId]
      return sender
        ? {
            id: sender.id,
            title: sessionTitle(sender),
            agentId: sender.agentId,
            projectPath: sender.projectPath,
          }
        : null
    }),
  )
}

export interface SessionReportTime {
  label: string
  title: string
  iso: string
}

export interface SessionReportTarget {
  entryId: string
  pos: number | null
}

export interface SessionReportDisplay {
  sentence: string
  roundLabel: string | null
  time: SessionReportTime | null
  metaLabel: string | null
  openLabel: string
  target: SessionReportTarget | null
}

/** The words of a report of a turn the session asked another one for, from how it ended. */
export function reportSentence(ended: FromSessionEnded): string {
  const agent = ended.agent || i18n.t('session:sessionReport.agent')
  switch (ended.stopReason) {
    case 'end_turn':
      return i18n.t('session:sessionReport.finished', { agent })
    case 'cancelled':
      return i18n.t('session:sessionReport.stopped', { agent })
    case null:
      return i18n.t('session:sessionReport.failed', { agent })
    default:
      return i18n.t('session:sessionReport.failedWith', {
        agent,
        reason: stopReasonText(ended.stopReason, 0),
      })
  }
}

/** Formats a positive integer round number, or null for legacy/invalid metadata. */
export function reportRoundLabel(round: number | undefined): string | null {
  if (typeof round !== 'number' || !Number.isSafeInteger(round) || round < 1) return null
  return i18n.t('session:sessionReport.round', { round })
}

/** Formats a completion timestamp as a compact local time (clock today, month+day+clock earlier). */
export function reportTime(
  completedAt: number | undefined,
  now = Date.now(),
): SessionReportTime | null {
  if (typeof completedAt !== 'number' || !Number.isFinite(completedAt) || completedAt <= 0) {
    return null
  }
  const date = new Date(completedAt)
  if (Number.isNaN(date.getTime())) return null
  return {
    label: daysBefore(completedAt, now) === 0 ? clockTime(completedAt) : monthDayTime(completedAt),
    title: fullTime(completedAt),
    iso: date.toISOString(),
  }
}

/** Extracts a valid round jump target from a completion report, or null for legacy reports. */
export function reportTarget(ended: FromSessionEnded): SessionReportTarget | null {
  if (typeof ended.entryId !== 'string' || ended.entryId === '') return null
  const pos =
    typeof ended.pos === 'number' && Number.isSafeInteger(ended.pos) && ended.pos >= 0
      ? ended.pos
      : null
  return { entryId: ended.entryId, pos }
}

/** Shared presentation fields for a child-session completion report in both thread and queue. */
export function sessionReportDisplay(
  ended: FromSessionEnded,
  title: string,
  now = Date.now(),
): SessionReportDisplay {
  const sentence = reportSentence(ended)
  const roundLabel = reportRoundLabel(ended.round)
  const time = reportTime(ended.completedAt, now)
  const parts = [roundLabel, time?.label].filter(
    (part): part is string => typeof part === 'string' && part !== '',
  )
  const metaLabel = parts.length > 0 ? parts.join(i18n.t('session:summary.separator')) : null
  const openLabel =
    roundLabel !== null
      ? i18n.t('session:sessionReport.openRound', { round: ended.round, title })
      : i18n.t('session:sessionReport.openSession', { title })
  return {
    sentence,
    roundLabel,
    time,
    metaLabel,
    openLabel,
    target: reportTarget(ended),
  }
}

/**
 * Opens the reporting child session and, when round anchor metadata is present, queues a reveal
 * jump directly to that round's entry once the thread is loaded. Legacy reports simply open the
 * child session.
 */
export function openSessionReport(
  sender: { id: string; projectPath: string },
  ended: FromSessionEnded,
): void {
  const target = reportTarget(ended)
  if (target) {
    revealMessage({ sessionId: sender.id, entryId: target.entryId, pos: target.pos })
  }
  openSession(sender.id, sender.projectPath)
}
