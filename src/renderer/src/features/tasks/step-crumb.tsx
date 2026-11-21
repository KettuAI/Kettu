import { useState } from 'react'
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  ArrowTurnBackwardIcon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { SessionSummary } from '@shared/agent-host'
import type { RoundView, TaskSummary, TaskView } from '@shared/workflow'
import { backTo } from '@renderer/app/history'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { Glyph } from '@renderer/features/shell/glyph'
import { hostOfPath } from '@renderer/lib/host-paths'
import { agentName } from '@renderer/stores/agents'
import { useTasksStore } from '@renderer/stores/tasks'
import { openTask } from '@renderer/stores/view'
import { stepTitle } from './model'
import { TaskRing } from './task-ring'
import { useTaskView } from './use-task'

/** The round a step's session works on now: the latest that names it, as a resumed one does. */
function sessionRound(view: TaskView | undefined, sessionId: string): RoundView | undefined {
  return view?.rounds.findLast((round) => round.sessionId === sessionId)
}

/** The rounds a sent back note shows on: those still at work, not those that ended. */
const WORKING = new Set(['queued', 'starting', 'working', 'picking', 'stuck'])

/**
 * A step's session at the start of its top bar: its task's ring and name, back to the task's page,
 * then a chevron before the step's own mark and name; with the round it is on past the first.
 */
export function TaskCrumb({ summary }: { summary: SessionSummary }) {
  const ref = summary.task!
  const task = useTasksStore((s) => s.summaries[ref.taskId])
  // Read here for the round and the sent back note, which the bar and the thread show.
  useTaskView(ref.taskId)
  if (!task) return null
  return <TaskCrumbLink task={task} />
}

/** The task's ring and name, back to its page, and the chevron after them. */
export function TaskCrumbLink({ task }: { task: TaskSummary }) {
  const { t } = useTranslation('tasks')
  const label = t('crumb.back', { title: task.title })
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="quiet"
              size="compact"
              aria-label={label}
              className="ks-crumb h-6.5 min-w-16 shrink-1000 gap-1.5 pr-2 pl-1 font-normal"
              onClick={() => backTo({ kind: 'task', taskId: task.id }, () => openTask(task.id))}
            />
          }
        >
          <TaskRing task={task} size={15} />
          <span className="max-w-40 truncate">{task.title}</span>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <span className="ks-crumb-sep">
        <Glyph icon={ArrowRight01Icon} size={14} />
      </span>
    </>
  )
}

/** After a step's title in its top bar: the round its session works on, past the first. */
export function StepRoundBadge({ summary }: { summary: SessionSummary }) {
  const { t } = useTranslation('tasks')
  const view = useTasksStore((s) => (summary.task ? s.views[summary.task.taskId] : undefined))
  const round = sessionRound(view, summary.id)
  if (!round || round.n < 2) return null
  return (
    <span className="h-5 shrink-0 rounded-md bg-(--shell-chip) px-1.5 text-[11.5px] leading-5 text-(--shell-muted)">
      {t('round', { n: round.n })}
    </span>
  )
}

/**
 * On top of a step's thread while its round works: who sent it back and why, and how often it may
 * still be. One quiet line, which opens to the whole note and the document's comments.
 */
export function StepSentBack({ summary }: { summary: SessionSummary }) {
  const { t } = useTranslation('tasks')
  const ref = summary.task!
  const { view } = useTaskView(ref.taskId)
  const [open, setOpen] = useState(false)
  const round = sessionRound(view, summary.id)
  const sent = round?.sentBack
  if (!view || !round || !sent || !WORKING.has(round.state)) return null
  const hostId = hostOfPath(view.projectPath)
  const from = view.rounds.find((r) => r.id === sent.roundId)
  const by =
    sent.by === 'person'
      ? t('sentBack.byYou')
      : t('sentBack.byStep', { step: stepTitle(view.workflow, sent.stepId) })
  const agent = sent.by === 'agent' && from?.by ? agentName(from.by.agentId, hostId) : null
  const left = sent.limit - sent.count
  const items = [sent.note, ...sent.comments].filter((text): text is string => !!text?.trim())
  const more = items.length > 1 || (items[0]?.length ?? 0) > 100 || !!items[0]?.includes('\n')
  return (
    <div className="px-8 pt-3">
      <div
        className="mx-auto w-full max-w-(--thread-column) rounded-xl bg-(--shell-chip) px-3.5 py-2.5 text-control text-(--shell-ink)"
        data-selectable=""
      >
        <div className="flex min-w-0 items-center gap-2">
          <Glyph icon={ArrowTurnBackwardIcon} size={14} className="shrink-0 text-warning" />
          <span className="shrink-0 font-medium">{by}</span>
          <span className="min-w-0 truncate text-hint text-(--shell-muted)">
            {[agent, left > 0 ? t('sentBack.left', { count: left }) : t('sentBack.last')]
              .filter(Boolean)
              .join(t('separator'))}
          </span>
          <span className="flex-1" />
          {more && (
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen(!open)}
              className="flex shrink-0 items-center gap-1 rounded-md px-1 text-hint text-(--shell-muted) hover:text-(--shell-ink) focus-visible:outline-[1.5px] focus-visible:outline-(--focus)"
            >
              {open ? t('sentBack.less') : t('sentBack.more')}
              <Glyph icon={open ? ArrowDown01Icon : ArrowRight01Icon} size={12} />
            </button>
          )}
        </div>
        {items.length > 0 &&
          (open ? (
            <div className="mt-1.5 flex flex-col gap-1.5 pl-[22px] leading-relaxed">
              {sent.note && <p className="whitespace-pre-wrap">{sent.note}</p>}
              {sent.comments.length > 0 && (
                <ul className="flex list-disc flex-col gap-1 pl-4 whitespace-pre-wrap text-(--shell-text)">
                  {sent.comments.map((comment, i) => (
                    <li key={i}>{comment}</li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <p className="mt-1 truncate pl-[22px] text-(--shell-text)">{items[0]}</p>
          ))}
      </div>
    </div>
  )
}
