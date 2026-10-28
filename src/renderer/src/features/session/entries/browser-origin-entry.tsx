import { memo, useEffect, useRef, useState } from 'react'
import { GlobeIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { originLabel, type BrowserOriginAnswer, type BrowserOriginDecision } from '@shared/browser'
import { Card } from '@renderer/components/ui/card'
import { Kbd } from '@renderer/components/ui/kbd'
import { Spinner } from '@renderer/components/ui/spinner'
import { errorMessage } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import { useEntry, useEntryAnimation } from '../use-thread'

const DECISIONS: BrowserOriginDecision[] = ['session', 'project', 'deny']

const ANSWER_TEXT = {
  session: 'browserOrigin.answer.session',
  project: 'browserOrigin.answer.project',
  deny: 'browserOrigin.answer.deny',
  timeout: 'browserOrigin.answer.timeout',
} as const satisfies Record<BrowserOriginAnswer | (string & {}), string>

/**
 * An agent's page asked to open a new site: a card like a permission request, with the origin as
 * its title and the three answers, which the pane's bar shows too. Answering either answers both.
 */
export const BrowserOriginEntry = memo(function BrowserOriginEntry({
  sessionId,
  entryId,
  agentName,
}: {
  sessionId: string
  entryId: string
  agentName: string
}) {
  const { t } = useTranslation('session')
  const entry = useEntry(sessionId, entryId, 'browser_origin')
  const animation = useEntryAnimation(sessionId, entryId)
  const [answering, setAnswering] = useState<BrowserOriginDecision | null>(null)
  const [error, setError] = useState<string | null>(null)
  const card = useRef<HTMLDivElement>(null)
  const waiting = entry?.decision === null

  useEffect(() => {
    if (waiting) card.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [waiting])

  if (!entry) return null
  const answer = async (decision: BrowserOriginDecision) => {
    setAnswering(decision)
    setError(null)
    try {
      await window.overbench.browser.answerOrigin(sessionId, entry.requestId, decision)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setAnswering(null)
    }
  }

  return (
    <Card
      ref={card}
      variant="tool"
      role="group"
      aria-label={t('browserOrigin.label')}
      data-entry-id={entryId}
      className={cn(
        'animate-attention shadow-attention',
        animation,
        // Once answered the card keeps its place in the history, without the attention ring.
        !waiting && 'animate-none shadow-none',
      )}
    >
      <div className="flex h-card-header w-full min-w-0 items-center gap-2 px-3 text-left text-tertiary">
        <GlobeIcon aria-hidden className="size-3.5 shrink-0 text-icon" />
        <span className="min-w-0 flex-1 truncate text-ui font-medium text-primary">
          {originLabel(entry.origin)}
        </span>
        <Status decision={entry.decision} />
      </div>
      {waiting ? (
        <div className="flex flex-col border-t border-border-soft p-3">
          <p className="mx-0.5 mb-2.5 text-ui text-secondary">
            {t('browserOrigin.ask', { agent: agentName })}
          </p>
          <div
            role="group"
            aria-label={t('browserOrigin.answerGroup')}
            className="-mx-1.5 -mb-1 flex flex-col gap-px"
          >
            {DECISIONS.map((decision, i) => (
              <button
                key={decision}
                type="button"
                disabled={answering !== null}
                data-origin-decision={i + 1}
                onClick={() => void answer(decision)}
                className="flex h-8.5 w-full min-w-0 cursor-default items-center gap-2.5 rounded-lg pr-2.5 pl-2 text-left text-ui text-foreground outline-none transition-colors duration-(--duration-fast) hover:bg-selected focus-ring disabled:opacity-60"
              >
                {answering === decision ? (
                  <span className="flex size-5 shrink-0 items-center justify-center">
                    <Spinner className="size-3.5" />
                  </span>
                ) : (
                  <Kbd aria-hidden variant={i === 0 ? 'primary' : 'default'}>
                    {i + 1}
                  </Kbd>
                )}
                <span className="min-w-0 flex-1 truncate">
                  {t(`browserOrigin.decision.${decision}`)}
                </span>
              </button>
            ))}
          </div>
          {error && <p className="mx-0.5 mt-2 text-xs text-danger">{error}</p>}
        </div>
      ) : null}
    </Card>
  )
})

function Status({ decision }: { decision: BrowserOriginAnswer | null }) {
  const { t } = useTranslation('session')
  if (decision === null) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.75 text-xs font-medium text-attention">
        <span
          aria-hidden
          className="size-2 rounded-full bg-attention-dot ring-3 ring-attention-dot/16"
        />
        {t('browserOrigin.waiting')}
      </span>
    )
  }
  return (
    <span className="shrink-0 animate-in text-xs text-tertiary animation-duration-(--duration-base) fade-in">
      {t(ANSWER_TEXT[decision])}
    </span>
  )
}
