import { ArrowDown01Icon, PlusSignIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { Dropdown, Icon } from '@renderer/components/affect/app-shell'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { longAgo } from '@renderer/lib/format'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { hostOfSession } from '@renderer/stores/sessions'
import { NEW_SESSION, useTargetName, type SendTargets } from './send-targets'

/** "To" and the session things go to, with every other one that wrote the artifact. */
export function ToMenu({
  targets,
  target,
  onPick,
  compact = false,
}: {
  targets: SendTargets
  target: string
  onPick: (target: string) => void
  compact?: boolean
}) {
  const { t } = useTranslation(['artifacts', 'common'])
  const now = useNow()
  const name = useTargetName()
  const picked = targets.sessions.find((s) => s.id === target) ?? null
  return (
    <Dropdown
      side="top"
      title={t('send.wrote')}
      className="k-vt-to-wrap"
      items={[
        ...targets.sessions.map((session) => ({
          label:
            session.id === targets.beside
              ? t('send.thisSession')
              : (session.title ?? t('common:untitledSession')),
          description: targets.writing.has(session.id)
            ? t('send.writingNow')
            : longAgo(session.updatedAt, now),
          logo: <AgentMark agent={session.agentId} size={16} hostId={hostOfSession(session)} />,
          checked: session.id === target,
          onSelect: () => onPick(session.id),
        })),
        {
          label: t('send.newSession'),
          icon: PlusSignIcon,
          divider: targets.sessions.length > 0,
          checked: target === NEW_SESSION,
          onSelect: () => onPick(NEW_SESSION),
        },
      ]}
      trigger={({ open, toggle }) => (
        <button
          type="button"
          aria-label={t('comments.sendTo')}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={toggle}
          data-compact={compact || undefined}
          className={cn('k-vt-to')}
          title={name(targets, target)}
        >
          <span className="k-vt-to__lead">{t('send.to')}</span>
          {picked ? (
            <AgentMark agent={picked.agentId} size={14} hostId={hostOfSession(picked)} />
          ) : (
            <Icon icon={PlusSignIcon} size={14} />
          )}
          <b>{name(targets, target)}</b>
          <Icon icon={ArrowDown01Icon} size={13} />
        </button>
      )}
    />
  )
}
