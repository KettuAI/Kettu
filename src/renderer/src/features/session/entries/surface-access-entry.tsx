import { memo } from 'react'
import { ComputerTerminal01Icon, GlobalIcon, PencilEdit02Icon } from '@hugeicons/core-free-icons'
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

const RENAME_TEXT = {
  allow: 'terminalRename.answer.allow',
  deny: 'terminalRename.answer.deny',
  timeout: 'terminalAccess.answer.timeout',
  revoked: 'terminalRename.answer.allow',
} as const satisfies Record<SurfaceAccessAnswer | 'revoked', string>

/**
 * An agent asked to use a terminal or browser tab the user opened in its session, or to rename a
 * terminal of theirs.
 */
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
  const rename = entry.rename
  const page = entry.surface === 'browser'
  const texts = rename === undefined ? ANSWER_TEXT : RENAME_TEXT
  const allow = t(
    rename === undefined ? 'terminalAccess.decision.allow' : 'terminalRename.decision.allow',
  )
  return (
    <AccessCard
      sessionId={sessionId}
      entryId={entryId}
      agentName={agentName}
      className={animation}
      action={t(
        page
          ? 'access.action.tab'
          : rename === undefined
            ? 'access.action.terminal'
            : 'access.action.terminalRename',
      )}
      target={entry.targetName}
      glyph={page ? GlobalIcon : rename === undefined ? ComputerTerminal01Icon : PencilEdit02Icon}
      reason={
        page
          ? t('tabAccess.where')
          : rename === undefined
            ? t(entry.readOnly ? 'terminalAccess.whereRead' : 'terminalAccess.where')
            : rename
              ? t('terminalRename.to', { name: rename })
              : t('terminalRename.toAuto')
      }
      // The card reads an allow for this session as its own.
      answer={entry.revoked ? 'revoked' : entry.decision === 'allow' ? 'session' : entry.decision}
      device={entry.device}
      words={{
        allow: { session: allow, always: allow },
        deny: t(
          rename === undefined ? 'terminalAccess.decision.deny' : 'terminalRename.decision.deny',
        ),
        answer: (a) =>
          t(a === 'session' ? texts.allow : (texts[a as keyof typeof texts] ?? texts.deny)),
      }}
      trailing={null}
      request={(decision) =>
        host('surfaces.answerAccess', {
          sessionId,
          entryId: entry.id,
          decision: decision === 'deny' ? 'deny' : 'allow',
        })
      }
    />
  )
})
