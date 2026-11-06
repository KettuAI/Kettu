import { memo, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '@renderer/components/affect/app-shell'
import { cn } from '@renderer/lib/utils'
import { toolMedia } from '../media/named'
import { useEntry, useEntryAnimation } from '../use-thread'
import { ElicitationCard, ElicitationSettled } from './elicitation-card'
import { PermissionEntry } from './permission-card'
import { PlanCard, PlanSettled } from './plan-card'
import { AnsweredAsk, OptionQuestionCard, QuestionCard } from './question-card'
import { StepCard } from './tool-call'
import { stepFacts, useToolCallLabels } from './tool-call-model'

export interface ToolCardProps {
  sessionId: string
  entryId: string
  projectPath: string
  agentName: string
}

/**
 * A tool call on its own: a request waiting for the user as its card, an answered question, plan or
 * form as what it settled on, and anything else as its Tool Call Card.
 */
export const ToolCard = memo(function ToolCard({
  sessionId,
  entryId,
  projectPath,
  agentName,
}: ToolCardProps) {
  const { t } = useTranslation('session')
  const entry = useEntry(sessionId, entryId, 'tool')
  const animation = useEntryAnimation(sessionId, entryId)
  const labels = useToolCallLabels()
  const ref = useRef<HTMLDivElement>(null)
  const permission = entry?.permission ?? null
  const media = useMemo(() => (entry ? toolMedia(entry) : []), [entry])

  useEffect(() => {
    if (permission) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [permission])

  if (!entry) return null
  const result = entry.permissionResult
  if (permission) {
    // Each request gets a card of its own, so an agent's next question in the same entry starts
    // unanswered rather than inheriting the last one's pending answer.
    const props = {
      ref,
      sessionId,
      entry,
      agentName,
      className: animation,
    }
    if (permission.plan) return <PlanCard key={permission.requestId} {...props} />
    if (permission.elicitation) return <ElicitationCard key={permission.requestId} {...props} />
    if (permission.questions) return <QuestionCard key={permission.requestId} {...props} />
    if (entry.question !== undefined) {
      return <OptionQuestionCard key={permission.requestId} {...props} />
    }
  }
  if (entry.planVersion !== undefined) {
    return (
      <div ref={ref} className={cn('min-w-0', animation)}>
        <PlanSettled entry={entry} />
      </div>
    )
  }
  if (entry.elicitation) {
    return (
      <div ref={ref} className={cn('min-w-0', animation)}>
        <ElicitationSettled entry={entry} />
      </div>
    )
  }
  if (typeof result === 'object' && result?.questions) {
    return (
      <div ref={ref} data-entry-id={entryId} className={cn('min-w-0', animation)}>
        <AnsweredAsk questions={result.questions} device={result.device?.name ?? null} />
      </div>
    )
  }
  if (entry.question !== undefined && result) {
    const answer =
      typeof result !== 'object'
        ? t(`permission.answer.${result}`)
        : (result.name ??
          (result.kind === 'allow_once' || result.kind === 'allow_always'
            ? t('question.answeredOne')
            : t('question.answeredOther')))
    return (
      <div ref={ref} data-entry-id={entryId} className={cn('min-w-0', animation)}>
        <AnsweredAsk
          questions={[{ question: entry.question, answered: true, answer }]}
          device={typeof result === 'object' ? (result.device?.name ?? null) : null}
        />
      </div>
    )
  }
  // A request waiting for the user, and once answered its folded card over the call: one element
  // throughout, so the card folds where it stands.
  if (permission || (result && (typeof result !== 'object' || result.by !== 'routine'))) {
    return (
      <PermissionEntry
        ref={ref}
        sessionId={sessionId}
        entry={entry}
        projectPath={projectPath}
        agentName={agentName}
        media={media}
        className={animation}
      />
    )
  }
  const { glyph, ...facts } = stepFacts(sessionId, entry)!
  return (
    <div ref={ref} className={cn('min-w-0', animation)}>
      <StepCard
        {...facts}
        icon={<Icon icon={glyph} size={14} />}
        sessionId={sessionId}
        entry={entry}
        projectPath={projectPath}
        labels={labels}
      />
    </div>
  )
})
