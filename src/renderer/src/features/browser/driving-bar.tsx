import type { AgentId } from '@shared/thread'
import { useTranslation } from 'react-i18next'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { agentName } from '@renderer/stores/agents'

/**
 * At the end of the address row: the agent whose call drives the page, with **Take over**; or that
 * the user drives, with **Hand back**, while the agent's calls wait.
 */
export function DrivingPill({
  agent,
  user,
  onTakeOver,
  onHandBack,
}: {
  agent: AgentId | null
  user: boolean
  onTakeOver: () => void
  onHandBack: () => void
}) {
  const { t } = useTranslation('browser')
  return (
    <div
      role="status"
      className="app-region-no-drag flex h-7.5 shrink-0 items-center gap-2 rounded-xl pr-1 pl-2.5 text-hint whitespace-nowrap text-primary shadow-[inset_0_0_0_var(--hairline)_var(--border-default)]"
      data-driving-bar=""
    >
      {!user && agent && <AgentMark agent={agent} size={14} />}
      {user ? t('control.you') : t('control.using', { agent: agent ? agentName(agent) : '' })}
      <button
        type="button"
        onClick={user ? onHandBack : onTakeOver}
        className="h-5.5 rounded-md bg-subtle px-2 text-small font-medium text-primary transition-colors duration-(--duration-fast) outline-none hover:bg-selected focus-ring"
      >
        {user ? t('control.handBack') : t('control.takeOver')}
      </button>
    </div>
  )
}
