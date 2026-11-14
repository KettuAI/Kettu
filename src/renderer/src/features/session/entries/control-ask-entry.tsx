import { memo } from 'react'
import { Key01Icon } from '@hugeicons/core-free-icons'
import { Trans, useTranslation } from 'react-i18next'
import { host } from '@renderer/lib/host'
import { useEntry, useEntryAnimation } from '../use-thread'
import { AccessCard } from './access-card'

/**
 * A step the agent asked the user to do on a surface, such as signing in on its page: Done lets
 * its call go on, Skip tells it the step was not done. Answered here, on the surface's pill or on
 * the composer's label alike; the turn's end settles it too.
 */
export const ControlAskEntry = memo(function ControlAskEntry({
  sessionId,
  entryId,
  agentName,
}: {
  sessionId: string
  entryId: string
  agentName: string
}) {
  const { t } = useTranslation('control')
  const entry = useEntry(sessionId, entryId, 'control_ask')
  const animation = useEntryAnimation(sessionId, entryId)
  if (!entry) return null
  const step = entry.step
  return (
    <AccessCard
      sessionId={sessionId}
      entryId={entryId}
      agentName={agentName}
      className={animation}
      action={t(`card.what.${step}`)}
      title={(agent, what) => (
        <Trans
          t={t}
          i18nKey="card.title"
          values={{ agent, what }}
          components={{ b: <b dir="auto" /> }}
        />
      )}
      target={entry.target ?? t('card.where.browser')}
      glyph={Key01Icon}
      reason={entry.reason}
      // The card reads Done as its allow; Skip and the turn's end as the rest.
      answer={entry.outcome === null ? null : entry.outcome === 'done' ? 'session' : entry.outcome}
      device={entry.device}
      words={{
        allow: { session: t('actions.done'), always: t('actions.done') },
        deny: t('actions.skip'),
        answer: (answer) =>
          answer === 'session'
            ? t(`card.answer.done.${step}`)
            : answer === 'skipped'
              ? t('card.answer.skipped')
              : t('card.answer.ended'),
      }}
      request={(decision) =>
        host('control.answerAsk', {
          sessionId,
          entryId: entry.id,
          outcome: decision === 'deny' ? 'skipped' : 'done',
        })
      }
      trailing={null}
    />
  )
})
