import { useState } from 'react'
import { Cancel01Icon, CheckmarkCircle02Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { originLabel, type BrowserOriginDecision, type BrowserOriginRequest } from '@shared/browser'
import type { AgentId } from '@shared/thread'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { PaneIcon, PaneSpinner } from '@renderer/features/shell/panel-button'

/**
 * Under the address: a new site the agent's page wants to open, with the three answers, and once
 * answered one line with what was chosen or that no answer came in time.
 */
export function OriginBar({
  request,
  agent,
  hostId,
  agentName,
  onAnswer,
}: {
  request: BrowserOriginRequest
  agent: AgentId | null
  /** The host the agent is on, null for this computer. */
  hostId: string | null
  agentName: string
  onAnswer: (decision: BrowserOriginDecision) => void
}) {
  const { t } = useTranslation('browser')
  const [answering, setAnswering] = useState<BrowserOriginDecision | null>(null)
  const label = originLabel(request.origin)

  if (request.decision !== null) {
    const allowed = request.decision === 'session' || request.decision === 'project'
    return (
      <div
        role="status"
        className="kp-origin"
        data-answered=""
        data-denied={allowed ? undefined : ''}
        data-origin-bar=""
      >
        <span className="kp-origin__text">
          <PaneIcon icon={allowed ? CheckmarkCircle02Icon : Cancel01Icon} size={14} />
          <span className="truncate">
            {t(`origin.answer.${request.decision}`, { origin: label })}
          </span>
        </span>
      </div>
    )
  }

  const answer = (decision: BrowserOriginDecision) => {
    setAnswering(decision)
    onAnswer(decision)
  }
  return (
    <div role="alert" className="kp-origin" data-origin-bar="">
      {/* The agent's name gives way before the site does: the site is what the user judges. */}
      <span className="kp-origin__text">
        {agent && <AgentMark agent={agent} size={14} hostId={hostId} />}
        <span className="truncate">
          {t('origin.asks', { agent: agentName })} <b>{label}</b>
        </span>
      </span>
      <span className="kp-origin__acts">
        {answering ? (
          <PaneSpinner />
        ) : (
          <>
            <button type="button" className="kp-btn kp-btn--sm" onClick={() => answer('deny')}>
              {t('origin.decision.deny')}
            </button>
            <span className="kp-origin__gap" />
            <button type="button" className="kp-btn kp-btn--sm" onClick={() => answer('project')}>
              {t('origin.decision.project')}
            </button>
            <button
              type="button"
              className="kp-btn kp-btn--sm kp-btn--solid"
              onClick={() => answer('session')}
            >
              {t('origin.decision.session')}
            </button>
          </>
        )}
      </span>
    </div>
  )
}
