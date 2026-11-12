import { memo } from 'react'
import { Bug01Icon, PencilEdit02Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { ReportRequest } from '@shared/report'
import type { ProblemReportEntry as Entry } from '@shared/thread'
import { toast } from '@renderer/components/ui/toast'
import { recordAction } from '@renderer/lib/action-log'
import { useCloudOff } from '@renderer/lib/cloud'
import { host } from '@renderer/lib/host'
import { hostOfPath } from '@renderer/lib/host-paths'
import { isWeb } from '@renderer/lib/platform'
import { useAccountStore } from '@renderer/stores/account'
import { openReport } from '@renderer/stores/report'
import { useSessionsStore } from '@renderer/stores/sessions'
import { NOT_SUBMITTED, prepare, submit } from '../../report/report-flow'
import { useEntry, useEntryAnimation } from '../use-thread'
import { AccessCard, type AccessDecision } from './access-card'

/** How the card reads an outcome: a sent or saved report as allowed, one not sent as denied. */
function shown(entry: Entry): string | null {
  if (entry.outcome === null) return null
  return entry.outcome.kind === 'skipped' ? 'deny' : 'session'
}

/**
 * A problem report the agent drafted, on the permission card: Don't send, Send to Kettu (or Save
 * locally), and Edit… to open the report dialog with the draft. Nothing is sent before the user
 * answers, and the card does not hold the turn.
 */
export const ProblemReportEntry = memo(function ProblemReportEntry({
  sessionId,
  entryId,
  agentName,
}: {
  sessionId: string
  entryId: string
  agentName: string
}) {
  const { t } = useTranslation(['session', 'report'])
  const entry = useEntry(sessionId, entryId, 'problem_report')
  const animation = useEntryAnimation(sessionId, entryId)
  const agentId = useSessionsStore((s) => s.byId[sessionId]?.agentId ?? null)
  const hostId = useSessionsStore((s) => hostOfPath(s.byId[sessionId]?.projectPath ?? ''))
  const signedIn = useAccountStore((s) => s.status?.state === 'signed-in')
  // Self-hosted, reports are only saved: nothing goes to Kettu.
  const cloudOff = useCloudOff()
  if (!entry) return null

  // This computer's sign-in is known here; another host answers for its own.
  const saveOnly = cloudOff || (hostId === null && !isWeb && !signedIn)
  const description = `${entry.title}\n\n${entry.details}`
  const context = { sessionId, agentId, error: entry.error }
  const reason = entry.error ? `${entry.details}\n\n${entry.error}` : entry.details

  const answer = (outcome: Entry['outcome'] & object) =>
    host('sessions.answerReport', { sessionId, entryId, outcome })

  const send = async (): Promise<void> => {
    const request: ReportRequest = { description, range: { kind: 'hour' }, extras: [], context }
    const { result, ref } = await prepare(hostId, request)
    if (!result.ok) {
      throw new Error(t(result.reason === 'too_large' ? 'tooLarge' : 'failed', { ns: 'report' }))
    }
    const report = result.report
    try {
      if (saveOnly) {
        recordAction('report.save', { files: report.files.length, drafted: true })
        const path = await window.kettu.report.save(report.id)
        if (path === null) return
        await answer({ kind: 'saved' })
        toast(t('saved', { ns: 'report' }), undefined, { tone: 'success' })
        return
      }
      recordAction('report.submit', { files: report.files.length, drafted: true })
      const sent = await submit(hostId, { report, ref })
      if (!sent.ok) throw new Error(t(NOT_SUBMITTED[sent.reason], { ns: 'report' }))
      await answer({ kind: 'sent', reportId: sent.id })
    } finally {
      void window.kettu.report.discard(report.id)
    }
  }

  const request = async (decision: AccessDecision): Promise<void> => {
    if (decision === 'deny') await answer({ kind: 'skipped' })
    else await send()
  }

  const outcome = entry.outcome
  return (
    <AccessCard
      sessionId={sessionId}
      entryId={entryId}
      agentName={agentName}
      className={animation}
      action={t('problemReport.action')}
      target={entry.title}
      glyph={Bug01Icon}
      reason={reason}
      preview={[
        { id: 'about', label: t('problemReport.attached.about') },
        { id: 'logs', label: t('problemReport.attached.logs') },
        { id: 'ids', label: t('problemReport.attached.ids') },
      ]}
      previewTitle={t('problemReport.attached.title')}
      answer={shown(entry)}
      device={entry.device}
      words={{
        allow: {
          session: saveOnly ? t('problemReport.save') : t('problemReport.send'),
          always: '',
        },
        deny: t('problemReport.skip'),
        answer: () =>
          outcome?.kind === 'sent'
            ? t('problemReport.answer.sent', { id: outcome.reportId })
            : outcome?.kind === 'saved'
              ? t('problemReport.answer.saved')
              : t('problemReport.answer.skipped'),
      }}
      request={request}
      trailing={{
        glyph: PencilEdit02Icon,
        label: t('problemReport.edit'),
        onClick: () =>
          void openReport({
            hostId,
            context,
            description,
            entry: { sessionId, entryId },
          }),
      }}
    />
  )
})
