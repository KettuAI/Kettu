import { memo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '@renderer/components/affect/app-shell'
import { cn } from '@renderer/lib/utils'
import { useEntry, useEntryAnimation } from '../use-thread'
import { ElicitationSettled } from './elicitation-card'
import { PermissionEntry } from './permission-card'
import { PlanSettled, PlanWaiting } from './plan-card'
import { AnsweredAsk } from './question-card'
import { StepCard } from './tool-call'
import { stepFacts, useToolCallLabels } from './tool-call-model'

export interface ToolCardProps {
  sessionId: string
  entryId: string
  projectPath: string
  agentName: string
}

/**
 * A tool call on its own: an answered question, plan or form as what it settled on, a request for
 * permission as its call, and anything else as its Tool Call Card. The Decision Card above the
 * composer asks what waits; of a question or form nothing shows here until it is answered, of a
 * plan its document.
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

  if (!entry) return null
  const result = entry.permissionResult
  if (permission) {
    if (permission.plan) {
      return (
        <div ref={ref} className={cn('min-w-0', animation)}>
          <PlanWaiting key={permission.requestId} entry={entry} />
        </div>
      )
    }
    if (permission.elicitation || permission.questions || entry.question !== undefined) {
      return null
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
