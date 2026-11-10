import { Tick02Icon } from '@hugeicons/core-free-icons'
import type { AgentId } from '@shared/thread'
import { useTranslation } from 'react-i18next'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { PaneIcon } from '@renderer/features/shell/panel-button'
import { cn } from '@renderer/lib/utils'
import { agentName } from '@renderer/stores/agents'

/**
 * Who drives a page or a device: the agent whose call drives it, with **Take over**; or the user,
 * with **Hand back**, while the agent's calls wait.
 */
export function DrivingPill({
  agent,
  hostId = null,
  user,
  onTakeOver,
  onHandBack,
  className,
}: {
  agent: AgentId | null
  /** The host the agent is on, null for this computer. */
  hostId?: string | null
  user: boolean
  onTakeOver: () => void
  onHandBack: () => void
  className?: string
}) {
  const { t } = useTranslation('browser')
  const label = user
    ? t('control.you')
    : t('control.using', { agent: agent ? agentName(agent, hostId) : '' })
  return (
    <div
      role="status"
      title={label}
      className={cn('kp-drive app-region-no-drag', className)}
      data-driver={user ? 'user' : 'agent'}
      data-driving-bar=""
    >
      {user ? (
        <PaneIcon icon={Tick02Icon} size={14} />
      ) : (
        agent && <AgentMark agent={agent} size={14} hostId={hostId} />
      )}
      <span className="kp-drive__label">{label}</span>
      <button type="button" onClick={user ? onHandBack : onTakeOver} className="kp-btn kp-btn--sm">
        {user ? t('control.handBack') : t('control.takeOver')}
      </button>
    </div>
  )
}
