import { memo } from 'react'
import { ComputerTerminal01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { ProjectHooksAnswer, ProjectHooksDecision } from '@shared/thread'
import { host } from '@renderer/lib/host'
import { useEntry, useEntryAnimation } from '../use-thread'
import { AccessCard, type AccessDecision } from './access-card'

const ANSWER_TEXT = {
  use: 'projectHooks.answer.use',
  all: 'projectHooks.answer.all',
  skip: 'projectHooks.answer.skip',
  timeout: 'projectHooks.answer.timeout',
} as const satisfies Record<ProjectHooksAnswer, string>

// The card's scopes: these hooks, or all of the project's, later ones too.
const DECISION = {
  session: 'use',
  always: 'all',
  deny: 'skip',
} as const satisfies Record<AccessDecision, ProjectHooksDecision>

// How AccessCard reads an answer: an allow by its scope, anything else as denied.
const SHOWN = {
  use: 'session',
  all: 'always',
  skip: 'deny',
  timeout: 'timeout',
} as const satisfies Record<ProjectHooksAnswer, string>

/** The session's folder declares hooks in its own settings, which wait for the user to run. */
export const ProjectHooksEntry = memo(function ProjectHooksEntry({
  sessionId,
  entryId,
  agentName,
}: {
  sessionId: string
  entryId: string
  agentName: string
}) {
  const { t } = useTranslation('session')
  const entry = useEntry(sessionId, entryId, 'project_hooks')
  const animation = useEntryAnimation(sessionId, entryId)
  if (!entry) return null
  return (
    <AccessCard
      sessionId={sessionId}
      entryId={entryId}
      agentName={agentName}
      className={animation}
      action={t('access.action.projectHooks')}
      target={[...new Set(entry.hooks.map((hook) => hook.event))].join(', ')}
      glyph={ComputerTerminal01Icon}
      reason={t('projectHooks.where')}
      preview={entry.hooks.map((hook, index) => ({
        id: String(index),
        label: hook.target ? `${hook.event} · ${hook.target}` : hook.event,
      }))}
      previewTitle={t('projectHooks.hooks')}
      answer={entry.decision === null ? null : SHOWN[entry.decision]}
      device={entry.device}
      words={{
        allow: { session: t('projectHooks.decision.use'), always: t('projectHooks.decision.all') },
        deny: t('projectHooks.decision.skip'),
        answer: () => t(ANSWER_TEXT[entry.decision ?? 'skip']),
      }}
      request={(decision) =>
        host('sessions.answerProjectHooks', {
          sessionId,
          entryId: entry.id,
          decision: DECISION[decision],
        })
      }
    />
  )
})
