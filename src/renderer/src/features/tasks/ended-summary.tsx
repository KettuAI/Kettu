// An ended task's page: what it delivered on top, then each step of its workflow as one row.

import {
  ArrowTurnBackwardIcon,
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  MinusSignCircleIcon,
  UserIcon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { TaskView, WorkflowStep } from '@shared/workflow'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Glyph } from '@renderer/features/shell/glyph'
import { runningFor } from '@renderer/lib/format'
import { hostOfPath } from '@renderer/lib/host-paths'
import { cn } from '@renderer/lib/utils'
import { useSessionsStore } from '@renderer/stores/sessions'
import { openSession, taskPanel } from '@renderer/stores/view'
import { DeliverableRows } from './deliverables'
import { latestRound, pickLine, stepTitle, useModelText } from './model'

export function Delivered({ view }: { view: TaskView }) {
  const { t } = useTranslation('tasks')
  const deliverables = view.deliverables ?? []
  if (deliverables.length === 0) return null
  return (
    <section className="flex flex-col gap-2">
      <h3 className="px-0.5 text-hint font-medium text-(--thread-muted)">{t('page.delivered')}</h3>
      <div className="rounded-xl bg-(--thread-card) px-3.5 py-3 shadow-(--thread-card-shadow)">
        <DeliverableRows
          deliverables={deliverables}
          panel={taskPanel(view.id)}
          projectPath={null}
          local={hostOfPath(view.projectPath) === null}
        />
      </div>
    </section>
  )
}

export function StepsSummary({ view }: { view: TaskView }) {
  const { t } = useTranslation('tasks')
  return (
    <section className="flex flex-col gap-2">
      <h3 className="px-0.5 text-hint font-medium text-(--thread-muted)">{t('page.steps')}</h3>
      <ol className="flex flex-col rounded-xl bg-(--thread-card) py-1 shadow-(--thread-card-shadow)">
        {view.workflow.steps.map((step) => (
          <StepRow key={step.id} view={view} step={step} />
        ))}
      </ol>
    </section>
  )
}

function StepRow({ view, step }: { view: TaskView; step: WorkflowStep }) {
  const { t } = useTranslation('tasks')
  const hostId = hostOfPath(view.projectPath)
  const rounds = view.rounds.filter((r) => r.stepId === step.id && r.startedAt !== null)
  const round = latestRound(view, step.id)
  const models = useModelText(hostId, round?.by ?? null)
  const session = useSessionsStore((s) => (round?.sessionId ? s.byId[round.sessionId] : undefined))
  const ran = rounds.length > 0
  const time = rounds.reduce((sum, r) => sum + ((r.endedAt ?? r.startedAt!) - r.startedAt!), 0)
  const backs = rounds.length - 1
  const state =
    round?.state === 'done'
      ? { icon: CheckmarkCircle02Icon, tone: 'text-success' }
      : round?.state === 'stuck'
        ? { icon: CancelCircleIcon, tone: 'text-danger' }
        : { icon: MinusSignCircleIcon, tone: 'text-tertiary' }
  const who = !ran
    ? t('steps.notRun')
    : [
        round?.by ? pickLine(round.by, hostId, models) : t('flow.you'),
        rounds.length > 1 ? t('steps.rounds', { count: rounds.length }) : null,
      ]
        .filter(Boolean)
        .join(t('separator'))
  const name = stepTitle(view.workflow, step.id)
  const open = session ? () => openSession(session.id, session.projectPath) : undefined
  return (
    <li>
      <button
        type="button"
        disabled={!open}
        onClick={open}
        className="flex w-full min-w-0 items-center gap-2.5 px-3.5 py-2 text-left enabled:hover:bg-(--thread-hover) focus-visible:outline-[1.5px] focus-visible:-outline-offset-[1.5px] focus-visible:outline-(--focus)"
      >
        <Glyph icon={state.icon} size={15} className={cn('shrink-0', state.tone)} />
        <span className="grid size-6 shrink-0 place-items-center rounded-md bg-(--thread-chip)">
          {round?.by ? (
            <AgentMark agent={round.by.agentId} size={13} hostId={hostId} />
          ) : (
            <Glyph icon={UserIcon} size={13} />
          )}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span
            className={cn(
              'truncate text-label font-medium',
              ran ? 'text-(--thread-ink)' : 'text-(--thread-faint)',
            )}
          >
            {name}
          </span>
          <span className="truncate text-hint text-(--thread-muted)">{who}</span>
        </span>
        {backs > 0 && (
          <span className="inline-flex shrink-0 items-center gap-1 text-hint text-warning">
            <Glyph icon={ArrowTurnBackwardIcon} size={12} />
            {t('steps.sentBack', { count: backs })}
          </span>
        )}
        {ran && (
          <span className="shrink-0 text-hint text-(--thread-text) tabular-nums">
            {runningFor(time)}
          </span>
        )}
      </button>
    </li>
  )
}
