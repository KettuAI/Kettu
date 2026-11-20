import { memo } from 'react'
import { ComputerTerminal01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { SurfaceAccessAnswer } from '@shared/control'
import { host } from '@renderer/lib/host'
import { useEntry, useEntryAnimation } from '../use-thread'
import { AccessCard } from './access-card'

const ANSWER_TEXT = {
  allow: 'terminalAccess.answer.allow',
  deny: 'terminalAccess.answer.deny',
  timeout: 'terminalAccess.answer.timeout',
  revoked: 'terminalAccess.answer.revoked',
} as const satisfies Record<SurfaceAccessAnswer | 'revoked', string>

/** An agent asked to use a terminal the user opened in its session. */
export const SurfaceAccessEntry = memo(function SurfaceAccessEntry({
  sessionId,
  entryId,
  agentName,
}: {
  sessionId: string
  entryId: string
  agentName: string
}) {
  const { t } = useTranslation('session')
  const entry = useEntry(sessionId, entryId, 'surface_access')
  const animation = useEntryAnimation(sessionId, entryId)
  if (!entry) return null
  const allow = t('terminalAccess.decision.allow')
  return (
    <AccessCard
      sessionId={sessionId}
      entryId={entryId}
      agentName={agentName}
      className={animation}
      action={t('access.action.terminal')}
      target={entry.targetName}
      glyph={ComputerTerminal01Icon}
      reason={t(entry.readOnly ? 'terminalAccess.whereRead' : 'terminalAccess.where')}
      // The card reads an allow for this session as its own.
      answer={entry.revoked ? 'revoked' : entry.decision === 'allow' ? 'session' : entry.decision}
      device={entry.device}
      words={{
        allow: { session: allow, always: allow },
        deny: t('terminalAccess.decision.deny'),
        answer: (a) =>
          t(
            a === 'session'
              ? ANSWER_TEXT.allow
              : (ANSWER_TEXT[a as keyof typeof ANSWER_TEXT] ?? ANSWER_TEXT.deny),
          ),
      }}
      trailing={null}
      request={(decision) =>
        host('terminals.answerAccess', {
          sessionId,
          entryId: entry.id,
          decision: decision === 'deny' ? 'deny' : 'allow',
        })
      }
    />
  )
})
