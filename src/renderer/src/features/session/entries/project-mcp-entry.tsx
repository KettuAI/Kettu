import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import type { ProjectMcpAnswer } from '@shared/thread'
import { projectMcpAsk } from '../decisions/access'
import { useEntry, useEntryAnimation } from '../use-thread'
import { AccessCard } from './access-card'

// How AccessCard reads an answer: an allow by its scope, anything else as denied.
const SHOWN = {
  use: 'session',
  all: 'always',
  skip: 'deny',
  timeout: 'timeout',
} as const satisfies Record<ProjectMcpAnswer, string>

/** The session's folder declares MCP servers of its own, which wait for the user to start. */
export const ProjectMcpEntry = memo(function ProjectMcpEntry({
  sessionId,
  entryId,
  agentName,
}: {
  sessionId: string
  entryId: string
  agentName: string
}) {
  const { t } = useTranslation('session')
  const entry = useEntry(sessionId, entryId, 'project_mcp')
  const animation = useEntryAnimation(sessionId, entryId)
  if (!entry) return null
  return (
    <AccessCard
      {...projectMcpAsk(t, sessionId, entry)}
      sessionId={sessionId}
      entryId={entryId}
      agentName={agentName}
      className={animation}
      answer={entry.decision === null ? null : SHOWN[entry.decision]}
      device={entry.device}
    />
  )
})
