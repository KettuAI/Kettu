import { memo, useEffect, useMemo, useRef } from 'react'
import { CheckIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AnsweredQuestion } from '@shared/thread'
import { cn } from '@renderer/lib/utils'
import { toolMedia } from '../media/named'
import { useEntry, useEntryAnimation } from '../use-thread'
import { ElicitationCard, ElicitationSettled } from './elicitation-card'
import { PermissionCard } from './permission-card'
import { PlanCard, PlanSettled } from './plan-card'
import { AnsweredQuestions, QuestionCard } from './question-card'
import { Icon } from '@renderer/components/affect/app-shell'
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
    return (
      <PermissionCard
        key={permission.requestId}
        {...props}
        projectPath={projectPath}
        media={media}
      />
    )
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
  const result = entry.permissionResult
  if (typeof result === 'object' && result?.questions) {
    return (
      <div ref={ref} data-entry-id={entryId} className={cn('min-w-0', animation)}>
        <AnsweredAsk questions={result.questions} device={result.device?.name ?? null} />
      </div>
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

/** An ask once answered: how many questions got an answer, and each question over its answer. */
function AnsweredAsk({
  questions,
  device,
}: {
  questions: AnsweredQuestion[]
  device: string | null
}) {
  const { t } = useTranslation('session')
  const given = questions.filter((q) => q.answered).length
  return (
    <div className="min-w-0 rounded-card bg-card shadow-card">
      <div className="flex min-h-12 min-w-0 items-center gap-2.5 py-2 pr-4 pl-4">
        <CheckIcon aria-hidden strokeWidth={2} className="size-4 shrink-0 text-secondary" />
        <span className="shrink-0 text-ui font-medium text-foreground">
          {given === 0
            ? t('question.skipped')
            : t('question.answered', { answered: given, total: questions.length })}
        </span>
        {device && <span className="min-w-0 truncate text-control text-tertiary">· {device}</span>}
      </div>
      <div className="px-4 pb-3 pl-11">
        <AnsweredQuestions questions={questions} />
      </div>
    </div>
  )
}
