import { memo } from 'react'
import { PlugSocketIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { ProjectMcpAnswer, ProjectMcpDecision } from '@shared/thread'
import { host } from '@renderer/lib/host'
import { useEntry, useEntryAnimation } from '../use-thread'
import { AccessCard, type AccessDecision } from './access-card'

const ANSWER_TEXT = {
  use: 'projectMcp.answer.use',
  all: 'projectMcp.answer.all',
  skip: 'projectMcp.answer.skip',
  timeout: 'projectMcp.answer.timeout',
} as const satisfies Record<ProjectMcpAnswer, string>

// The card's scopes: these servers, or all of the project's, later ones too.
const DECISION = {
  session: 'use',
  always: 'all',
  deny: 'skip',
} as const satisfies Record<AccessDecision, ProjectMcpDecision>

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
      sessionId={sessionId}
      entryId={entryId}
      agentName={agentName}
      className={animation}
      action={t('access.action.projectMcp')}
      target={entry.servers.map((server) => server.name).join(', ')}
      glyph={PlugSocketIcon}
      reason={t('projectMcp.where')}
      preview={entry.servers.map((server) => ({
        id: server.name,
        label: server.target ? `${server.name} · ${server.target}` : server.name,
      }))}
      previewTitle={t('projectMcp.servers')}
      answer={entry.decision === null ? null : SHOWN[entry.decision]}
      device={entry.device}
      words={{
        scope: { session: t('projectMcp.scope.use'), always: t('projectMcp.scope.all') },
        allow: { session: t('projectMcp.decision.use'), always: t('projectMcp.decision.all') },
        deny: t('projectMcp.decision.skip'),
        answer: () => t(ANSWER_TEXT[entry.decision ?? 'skip']),
      }}
      request={(decision) =>
        host('sessions.answerProjectMcp', {
          sessionId,
          entryId: entry.id,
          decision: DECISION[decision],
        })
      }
    />
  )
})
