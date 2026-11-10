import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { computerAppAsk } from '../decisions/access'
import { useEntry, useEntryAnimation } from '../use-thread'
import { AccessCard } from './access-card'

/** An agent asked to use an app on the user's computer for the first time in its session. */
export const ComputerAppEntry = memo(function ComputerAppEntry({
  sessionId,
  entryId,
  agentName,
}: {
  sessionId: string
  entryId: string
  agentName: string
}) {
  const { t } = useTranslation('session')
  const entry = useEntry(sessionId, entryId, 'computer_app')
  const animation = useEntryAnimation(sessionId, entryId)
  if (!entry) return null
  return (
    <AccessCard
      {...computerAppAsk(t, sessionId, entry)}
      sessionId={sessionId}
      entryId={entryId}
      agentName={agentName}
      className={animation}
      answer={entry.decision}
      device={entry.device}
    />
  )
})
