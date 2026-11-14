import { memo, useEffect } from 'react'
import { Key01Icon } from '@hugeicons/core-free-icons'
import { Trans, useTranslation } from 'react-i18next'
import { BrowserMark } from '@renderer/features/browser/sign-in-parts'
import { shortBrowserName } from '@renderer/features/browser/sign-in-text'
import { host } from '@renderer/lib/host'
import { bringOfferedSignIn, loadSources, useSignInOffer } from '@renderer/stores/sign-ins'
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
  const { t } = useTranslation(['control', 'browser'])
  const entry = useEntry(sessionId, entryId, 'control_ask')
  const animation = useEntryAnimation(sessionId, entryId)
  // A sign-in the card waits for may come from one of the user's own browsers instead.
  const signIn =
    entry?.outcome === null &&
    entry.surface === 'browser' &&
    entry.step === 'sign_in' &&
    entry.target
      ? `https://${entry.target}/`
      : null
  const offer = useSignInOffer(signIn)
  // The browser's icon comes with the list of browsers, read once a run.
  useEffect(() => {
    if (offer) void loadSources().catch(() => {})
  }, [offer])
  if (!entry) return null
  const step = entry.step
  const browser = offer ? shortBrowserName(offer.browserName) : ''
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
      trailing={
        offer
          ? {
              mark: <BrowserMark browser={offer.browser} size={14} />,
              label: t('browser:signIns.chip', { browser }),
              onClick: () => bringOfferedSignIn(offer, sessionId),
            }
          : null
      }
    />
  )
})
