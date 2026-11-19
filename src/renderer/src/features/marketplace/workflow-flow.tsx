// A workflow's flow on a listing: the chart, loaded when first shown, and under it each step with
// what it does and where its outcomes go, which also says in words what the chart draws.

import { lazy, Suspense } from 'react'
import { ArrowRight01Icon, SparklesIcon, UndoIcon, UserIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { stepName, type StepPick, type Workflow } from '@shared/workflow'
import { Icon } from '@renderer/components/affect/app-shell'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { backArrowsOf, outcomeTarget } from './workflow-model'

const WorkflowDiagram = lazy(() => import('./workflow-diagram'))

export function FlowSkeleton() {
  return <Skeleton className="k-flow-skeleton" />
}

/** The chart of a workflow's flow, read-only. */
export function FlowChart({
  workflow,
  pins,
}: {
  workflow: Workflow
  pins?: Record<string, StepPick>
}) {
  return (
    <div className="k-flow-card">
      <Suspense fallback={<FlowSkeleton />}>
        <WorkflowDiagram workflow={workflow} pins={pins} />
      </Suspense>
    </div>
  )
}

/**
 * Each step in the file's order: who does it, the start of what it is told, and where each of its
 * outcomes goes, an arrow back with how often it may be taken.
 */
export function StepsOutline({ workflow }: { workflow: Workflow }) {
  const { t, i18n } = useTranslation('marketplace')
  const locale = i18n.language
  return (
    <ol className="k-mkt-list k-flow-steps">
      {workflow.steps.map((step, index) => {
        const backs = backArrowsOf(workflow, step)
        return (
          <li key={step.id} className="k-flow-steps__step">
            <span className="k-flow-steps__n" aria-hidden>
              {index + 1}
            </span>
            <span className="k-flow-steps__text">
              <span className="k-flow-steps__name">
                <b>{stepName(workflow, step.id, locale)}</b>
                <span className="k-flow-steps__who" data-you={step.by === 'you' ? '' : undefined}>
                  <Icon icon={step.by === 'you' ? UserIcon : SparklesIcon} size={12} />
                  {step.by === 'you' ? t('workflow.you') : t('workflow.diagram.agentStep')}
                </span>
                {step.by === 'agent' && step.youReview && (
                  <span className="k-workflow-you">{t('workflow.youReview')}</span>
                )}
              </span>
              {step.prompt.trim() && <small data-selectable="">{step.prompt.trim()}</small>}
              <ul className="k-workflow-steps__outcomes" aria-label={t('workflow.steps.outcomes')}>
                {step.outcomes.map((outcome) => {
                  const target = outcomeTarget(workflow, outcome, locale)
                  const back = backs.includes(outcome)
                  return (
                    <li key={outcome.name}>
                      <span>{outcome.name}</span>
                      <Icon icon={back ? UndoIcon : ArrowRight01Icon} size={12} />
                      <span>
                        {target.kind === 'end'
                          ? t(target.end === 'done' ? 'workflow.end.done' : 'workflow.end.dropped')
                          : target.names.join(' + ')}
                      </span>
                      {back && (
                        <span className="k-workflow-steps__limit">
                          {t('workflow.steps.upTo', {
                            count: outcome.limit ?? workflow.sendBackLimit,
                          })}
                        </span>
                      )}
                    </li>
                  )
                })}
              </ul>
            </span>
          </li>
        )
      })}
    </ol>
  )
}
