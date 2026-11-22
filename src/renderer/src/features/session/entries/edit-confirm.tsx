import type { ReactNode } from 'react'
import {
  ComputerTerminal01Icon,
  File01Icon,
  StopCircleIcon,
  Timer02Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { cacheExpiry, knownExpiry } from '@shared/prompt-cache'
import { Button } from '@renderer/components/ui/button'
import { useCacheLeft, useCachePhase } from '@renderer/features/prompt-cache/cache-phase'
import { Glyph } from '@renderer/features/shell/glyph'
import { timeLeft, tokens } from '@renderer/lib/format'
import { agentsOn, useAgentsStore } from '@renderer/stores/agents'
import { hostOfSession } from '@renderer/stores/sessions'
import { useThreadsStore } from '@renderer/stores/threads'

/** What an edit from the entry takes away and stops, for its confirmation. */
export interface EditFacts {
  turns: number
  files: number
  commands: boolean
  running: boolean
  tasks: number
  /** The context up to the message, which an expired cache sends again; null when unknown. */
  kept: number | null
}

/** Edit from here's confirmation: what goes, and only the rows that apply of what stops. */
export function EditConfirm({
  sessionId,
  facts,
  onCancel,
  onEdit,
}: {
  sessionId: string
  facts: EditFacts
  onCancel: () => void
  onEdit: () => void
}) {
  const { t } = useTranslation(['session', 'common'])
  return (
    <div className="kettu-edit">
      <b>{t('editFrom.title')}</b>
      <p>{t('editFrom.body', { count: facts.turns })}</p>
      <ul>
        {facts.running && <Fact icon={StopCircleIcon}>{t('editFrom.stopsTurn')}</Fact>}
        {facts.tasks > 0 && (
          <Fact icon={ComputerTerminal01Icon}>
            {t('editFrom.stopsTasks', { count: facts.tasks })}
          </Fact>
        )}
        {facts.files > 0 && (
          <Fact icon={File01Icon}>{t('editFrom.files', { count: facts.files })}</Fact>
        )}
        <CacheFact sessionId={sessionId} kept={facts.kept} />
      </ul>
      <div className="kettu-edit__actions">
        <Button variant="outline" size="dialog" onClick={onCancel}>
          {t('common:actions.cancel')}
        </Button>
        <Button size="dialog" autoFocus onClick={onEdit}>
          {t('editFrom.confirm')}
        </Button>
      </div>
    </div>
  )
}

function Fact({
  icon,
  warn,
  children,
}: {
  icon: Parameters<typeof Glyph>[0]['icon']
  warn?: boolean
  children: ReactNode
}) {
  return (
    <li data-warn={warn ? '' : undefined}>
      <Glyph icon={icon} size={14} />
      <span className="min-w-0">{children}</span>
    </li>
  )
}

/** The prompt cache, for an agent that says when it expires: still warm, or what goes again. */
function CacheFact({ sessionId, kept }: { sessionId: string; kept: number | null }) {
  const { t } = useTranslation('session')
  const session = useThreadsStore(
    useShallow((s) => {
      const view = s.replicas[sessionId]?.state?.session
      return view
        ? {
            agentId: view.agentId,
            projectPath: view.projectPath,
            config: view.config,
            usage: view.usage,
          }
        : null
    }),
  )
  const account = useAgentsStore((s) =>
    session ? (agentsOn(s, hostOfSession(session)).byId[session.agentId]?.account ?? null) : null,
  )
  const expiry = knownExpiry(session ? cacheExpiry(session, account) : null)
  const phase = useCachePhase(expiry)
  const left = useCacheLeft(expiry?.expiresAt ?? null, timeLeft)
  if (!expiry || !phase) return null
  if (phase !== 'expired') {
    return <Fact icon={Timer02Icon}>{t('editFrom.cacheKept', { time: left })}</Fact>
  }
  return (
    <Fact icon={Timer02Icon} warn>
      {kept ? t('editFrom.cacheExpired', { tokens: tokens(kept) }) : t('editFrom.cacheExpiredOnly')}
    </Fact>
  )
}
