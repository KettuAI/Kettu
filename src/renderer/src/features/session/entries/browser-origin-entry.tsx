import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { browserOriginAsk } from '../decisions/access'
import { useEntry, useEntryAnimation } from '../use-thread'
import { AccessCard } from './access-card'

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
  const answer = entry.decision === 'project' ? 'always' : entry.decision
  return (
    <AccessCard
      {...browserOriginAsk(t, sessionId, entry)}
      sessionId={sessionId}
      entryId={entryId}
      agentName={agentName}
      className={animation}
      answer={answer}
      device={entry.device}
    />
  )
})
