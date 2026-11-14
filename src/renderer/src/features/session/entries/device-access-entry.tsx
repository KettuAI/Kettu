import { memo } from 'react'
import { SmartPhone01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { DeviceAccessAnswer } from '@shared/device-agent'
import { host } from '@renderer/lib/host'
import { useEntry, useEntryAnimation } from '../use-thread'
import { AccessCard } from './access-card'

const ANSWER_TEXT = {
  session: 'deviceAccess.answer.session',
  always: 'deviceAccess.answer.always',
  deny: 'deviceAccess.answer.deny',
  timeout: 'deviceAccess.answer.timeout',
  revoked: 'deviceAccess.answer.revoked',
} as const satisfies Record<DeviceAccessAnswer | 'revoked', string>

/** An agent asked to use a mobile device for the first time in its session. */
export const DeviceAccessEntry = memo(function DeviceAccessEntry({
  sessionId,
  entryId,
  agentName,
}: {
  sessionId: string
  entryId: string
  agentName: string
}) {
  const { t } = useTranslation('session')
  const entry = useEntry(sessionId, entryId, 'device_access')
  const animation = useEntryAnimation(sessionId, entryId)
  if (!entry) return null
  return (
    <AccessCard
      sessionId={sessionId}
      entryId={entryId}
      agentName={agentName}
      className={animation}
      action={t('access.action.device')}
      target={entry.deviceName}
      glyph={SmartPhone01Icon}
      reason={t('deviceAccess.where')}
      answer={entry.revoked ? 'revoked' : entry.decision}
      device={entry.device}
      words={{
        allow: {
          session: t('deviceAccess.decision.session'),
          always: t('deviceAccess.decision.always'),
        },
        deny: t('deviceAccess.decision.deny'),
        answer: (a) => t(ANSWER_TEXT[a as keyof typeof ANSWER_TEXT] ?? ANSWER_TEXT.deny),
      }}
      request={(decision) =>
        host('devices.answerAccess', { sessionId, entryId: entry.id, decision })
      }
    />
  )
})
