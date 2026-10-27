import type { AgentId } from '@shared/thread'
import { useTranslation } from 'react-i18next'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { agentName } from '@renderer/stores/agents'

/**
 * Under the pane's header: the agent whose call drives the page, with **Stop**; or that the user
 * has control, with **Hand back**, while the agent's calls wait.
 */
export function DrivingBar({
  agent,
  user,
  onStop,
  onHandBack,
}: {
  agent: AgentId | null
  user: boolean
  onStop: () => void
  onHandBack: () => void
}) {
  const { t } = useTranslation('browser')
  return (
    <div
      className="flex min-h-8 shrink-0 items-center gap-2 bg-info-tint px-3 text-small text-primary"
      data-driving-bar=""
    >
      {user ? (
        <>
          <span className="min-w-0 flex-1 truncate">{t('control.you')}</span>
          <button
            type="button"
            onClick={onHandBack}
            className="shrink-0 text-small font-medium text-link hover:underline focus-ring"
          >
            {t('control.handBack')}
          </button>
        </>
      ) : (
        <>
          {agent && <AgentMark agent={agent} size={12} />}
          <span className="min-w-0 flex-1 truncate">
            {t('control.using', { agent: agent ? agentName(agent) : '' })}
          </span>
          <button
            type="button"
            onClick={onStop}
            className="shrink-0 text-small font-medium text-link hover:underline focus-ring"
          >
            {t('control.stop')}
          </button>
        </>
      )}
    </div>
  )
}
