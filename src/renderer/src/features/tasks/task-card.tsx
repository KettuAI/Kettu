import type { ReactNode } from 'react'
import { GitBranchIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { StepState, TaskStepSummary, TaskSummary, TaskView } from '@shared/workflow'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Glyph } from '@renderer/features/shell/glyph'
import { hostOfPath } from '@renderer/lib/host-paths'
import { longAgo } from '@renderer/lib/format'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { agentName } from '@renderer/stores/agents'
import { progressText, workflowTitle, stepTitle, stepWord } from './model'
import { TaskRing } from './task-ring'

const DOT: Record<StepState, string> = {
  done: 'bg-(--thread-done)',
  running: 'bg-(--thread-fox)',
  needs_you: 'bg-warning',
  error: 'bg-danger',
  waiting: 'border-[1.5px] border-(--shell-line-strong)',
  not_reached: 'border-[1.5px] border-(--shell-line-strong)',
}

/**
 * What a task row's hover card says: the workflow and which step it is on, every step with its state,
 * the one in front in bold, then the agents, the branch and the latest activity.
 */
export function TaskCard({ task, view }: { task: TaskSummary; view: TaskView | undefined }) {
  const { t } = useTranslation('tasks')
  const now = useNow()
  const hostId = hostOfPath(task.projectPath)
  const progress = progressText(task)
  const front = task.at !== null ? task.steps[task.at - 1]?.id : undefined
  return (
    <div className="flex flex-col text-hint text-secondary">
      <div className="flex min-w-0 items-center gap-2">
        <TaskRing task={task} size={16} />
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-primary">
          {workflowTitle(task, view)}
        </span>
        {progress && <span className="shrink-0 text-tertiary tabular-nums">{progress}</span>}
      </div>
      <ol className="my-2.5 flex flex-col gap-1 border-y border-(--shell-line-strong) py-2.5">
        {task.steps.map((step) => (
          <li
            key={step.id}
            className={cn(
              'flex min-w-0 items-center gap-2',
              step.state === 'done' || step.id === front ? 'text-secondary' : 'text-tertiary',
              step.id === front && task.status === 'running' && 'font-medium text-primary',
            )}
          >
            <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', DOT[step.state])} />
            <span className="min-w-0 flex-1 truncate">
              {stepTitle(view?.workflow, step.id, step.name)}
            </span>
            <StepWord step={step} view={view} />
          </li>
        ))}
      </ol>
      <dl className="flex flex-col gap-[5px]">
        {task.agents.length > 0 && (
          <Line label={t('card.agents')}>
            {task.agents.map((agent) => (
              <AgentMark key={agent} agent={agent} size={13} hostId={hostId} />
            ))}
            <span className="truncate">
              {task.agents.map((agent) => agentName(agent, hostId)).join(t('list'))}
            </span>
          </Line>
        )}
        {task.branch && (
          <Line label={t('card.branch')}>
            <Glyph icon={GitBranchIcon} size={12} className="shrink-0" />
            <span className="truncate font-mono text-code">{task.branch}</span>
          </Line>
        )}
        <Line label={t('card.lastActivity')}>{longAgo(task.updatedAt, now)}</Line>
      </dl>
    </div>
  )
}

/** A step's state in a word, at the line's end; nothing for one not reached. */
export function StepWord({
  step,
  view,
  className,
}: {
  step: TaskStepSummary
  view: TaskView | undefined
  className?: string
}) {
  const { t } = useTranslation('tasks')
  const word = stepWord(step, view)
  if (!word) return null
  return (
    <span
      className={cn(
        'shrink-0',
        step.state === 'needs_you' && 'text-warning',
        step.state === 'error' && 'text-danger',
        className,
      )}
    >
      {t(`state.${word}`)}
    </span>
  )
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3">
      <dt className="shrink-0 text-tertiary">{label}</dt>
      <dd className="flex min-w-0 items-center gap-1.5 tabular-nums">{children}</dd>
    </div>
  )
}
