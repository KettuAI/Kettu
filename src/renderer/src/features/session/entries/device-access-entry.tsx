import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { deviceAccessAsk } from '../decisions/access'
import { useEntry, useEntryAnimation } from '../use-thread'
import { AccessCard } from './access-card'

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
      {...deviceAccessAsk(t, sessionId, entry)}
      sessionId={sessionId}
      entryId={entryId}
      agentName={agentName}
      className={animation}
      answer={entry.decision}
      device={entry.device}
    />
  )
})
