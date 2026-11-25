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

// What the card holds: commands, the env (rows named `env`), or both.
const COPY = {
  commands: {
    action: 'access.action.projectHooks',
    reason: 'projectHooks.where',
    title: 'projectHooks.hooks',
  },
  env: {
    action: 'access.action.projectEnv',
    reason: 'projectHooks.whereEnv',
    title: 'projectHooks.variables',
  },
  both: {
    action: 'access.action.projectHooksEnv',
    reason: 'projectHooks.whereBoth',
    title: 'projectHooks.both',
  },
} as const

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
  const env = entry.hooks.some((hook) => hook.event === 'env')
  const commands = entry.hooks.some((hook) => hook.event !== 'env')
  const copy = COPY[env ? (commands ? 'both' : 'env') : 'commands']
  const words = env ? 'projectHooks.allow' : 'projectHooks.decision'
  return (
    <AccessCard
      sessionId={sessionId}
      entryId={entryId}
      agentName={agentName}
      className={animation}
      action={t(copy.action)}
      target={[...new Set(entry.hooks.map((hook) => hook.event))].join(', ')}
      glyph={ComputerTerminal01Icon}
      reason={t(copy.reason)}
      preview={entry.hooks.map((hook, index) => ({
        id: String(index),
        label: hook.target ? `${hook.event} · ${hook.target}` : hook.event,
      }))}
      previewTitle={t(copy.title)}
      answer={entry.decision === null ? null : SHOWN[entry.decision]}
      device={entry.device}
      words={{
        allow: { session: t(`${words}.use`), always: t(`${words}.all`) },
        deny: t(`${words}.skip`),
        answer: () =>
          t(
            env && entry.decision === 'skip'
              ? 'projectHooks.answer.notAllowed'
              : ANSWER_TEXT[entry.decision ?? 'skip'],
          ),
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
