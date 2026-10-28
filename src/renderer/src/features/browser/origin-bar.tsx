import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { originLabel, type BrowserOriginDecision, type BrowserOriginRequest } from '@shared/browser'
import { Spinner } from '@renderer/components/ui/spinner'

const DECISIONS: BrowserOriginDecision[] = ['deny', 'project', 'session']
/**
 * Under the pane's header: a new site the agent's page wants to open, with the three answers, and
 * once answered what was chosen or that no answer came in time.
 */
export function OriginBar({
  request,
  agentName,
  onAnswer,
}: {
  request: BrowserOriginRequest
  agentName: string
  onAnswer: (decision: BrowserOriginDecision) => void
}) {
  const { t } = useTranslation('browser')
  const [answering, setAnswering] = useState<BrowserOriginDecision | null>(null)
  const label = originLabel(request.origin)

  if (request.decision !== null) {
    return (
      <div
        className="flex min-h-8 shrink-0 items-center gap-2 bg-warning-tint px-3 text-small text-secondary"
        data-origin-bar=""
      >
        <span className="min-w-0 flex-1 truncate">
          {t(`origin.answer.${request.decision}`, { origin: label })}
        </span>
      </div>
    )
  }

  return (
    <div
      className="flex min-h-8 shrink-0 items-center gap-2 bg-warning-tint px-3 text-small text-primary"
      data-origin-bar=""
    >
      {/* The agent's name gives way before the site does: the site is what the user judges. */}
      <span className="flex min-w-0 flex-1 items-baseline gap-1">
        <span className="min-w-0 truncate">{t('origin.asks', { agent: agentName })}</span>
        <span className="shrink-0 font-medium">{label}</span>
      </span>
      {answering ? (
        <Spinner className="size-3.5 shrink-0" />
      ) : (
        DECISIONS.map((decision) => (
          <button
            key={decision}
            type="button"
            disabled={answering !== null}
            onClick={() => {
              setAnswering(decision)
              onAnswer(decision)
            }}
            className={
              decision === 'session'
                ? 'shrink-0 text-small font-medium text-link hover:underline focus-ring'
                : 'shrink-0 text-small text-link hover:underline focus-ring'
            }
          >
            {t(`origin.decision.${decision}`)}
          </button>
        ))
      )}
    </div>
  )
}
