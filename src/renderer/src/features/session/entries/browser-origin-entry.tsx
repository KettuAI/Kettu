import { memo } from 'react'
import { Globe02Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { originLabel, type BrowserOriginAnswer } from '@shared/browser'
import { host } from '@renderer/lib/host'
import { useEntry, useEntryAnimation } from '../use-thread'
import { AccessCard } from './access-card'

const ANSWER_TEXT = {
  session: 'browserOrigin.answer.session',
  project: 'browserOrigin.answer.project',
  deny: 'browserOrigin.answer.deny',
  timeout: 'browserOrigin.answer.timeout',
} as const satisfies Record<BrowserOriginAnswer, string>

/**
 * An agent's page asked to open a new site, as a request like an agent's own: for this session or
 * always in this project, which the asking app's pane offers too.
 */
export const BrowserOriginEntry = memo(function BrowserOriginEntry({
  sessionId,
  entryId,
  agentName,
}: {
  sessionId: string
  entryId: string
  agentName: string
}) {
  const { t } = useTranslation('session')
  const entry = useEntry(sessionId, entryId, 'browser_origin')
  const animation = useEntryAnimation(sessionId, entryId)
  if (!entry) return null
  const site = originLabel(entry.origin)
  const answer = entry.decision === 'project' ? 'always' : entry.decision
  return (
    <AccessCard
      sessionId={sessionId}
      entryId={entryId}
      agentName={agentName}
      className={animation}
      action={t('access.action.site')}
      target={entry.origin}
      glyph={Globe02Icon}
      reason={t('browserOrigin.where')}
      answer={answer}
      device={entry.device}
      words={{
        allow: {
          session: t('browserOrigin.decision.session'),
          always: t('browserOrigin.decision.project', { site }),
        },
        deny: t('browserOrigin.decision.deny'),
        answer: (a) =>
          t(
            ANSWER_TEXT[(a === 'always' ? 'project' : a) as BrowserOriginAnswer] ??
              ANSWER_TEXT.deny,
          ),
      }}
      request={(decision) =>
        host('browser.answerOrigin', {
          sessionId,
          entryId: entry.id,
          decision: decision === 'always' ? 'project' : decision,
        })
      }
    />
  )
})
