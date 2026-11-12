import { useId, useState, type ReactNode } from 'react'
import { ArrowRight01Icon, Cancel01Icon, StopIcon, Tick02Icon } from '@hugeicons/core-free-icons'
import type { IconSvgElement } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import type { SessionSummary } from '@shared/agent-host'
import type { BackgroundTaskView } from '@shared/thread'
import {
  useLoadSubagent,
  type SubagentDigestOf,
} from '@renderer/features/session/subagent/progress'
import { PaneIcon } from '@renderer/features/shell/panel-button'
import { shortDuration } from '@renderer/lib/format'
import { sessionTitle } from '@renderer/stores/sessions'
import { openSession } from '@renderer/stores/view'
import { endedNote, subagentFailed } from './board-model'
import { Fold } from './row-parts'
import { TaskDetail } from './task-detail'
import { useTaskOutput } from './use-task-output'

/**
 * What ended, of one kind, behind a line that counts it and its failures. It opens in place to
 * one line each; the rows are made only once it has been opened.
 */
export function EndedGroup({
  icon,
  name,
  count,
  failed,
  open: initial = false,
  children,
}: {
  icon: IconSvgElement
  name: string
  count: number
  failed: number
  /** Starts opened, as when nothing runs above it. */
  open?: boolean
  children: ReactNode
}) {
  const { t } = useTranslation('board')
  const id = useId()
  const [open, setOpen] = useState(initial)
  const [made, setMade] = useState(initial)
  return (
    <div className="kb-group" data-open={open || undefined}>
      <button
        type="button"
        className="kb-sum"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          setMade(true)
          setOpen(!open)
        }}
      >
        <span className="kb-sum__mark">
          <PaneIcon icon={icon} size={15} />
        </span>
        <span className="kb-sum__name">{name}</span>
        {failed > 0 && (
          <span className="kb-sum__failed">{t('earlier.failed', { count: failed })}</span>
        )}
        <span className="kb-sum__n">{count}</span>
        <PaneIcon icon={ArrowRight01Icon} size={13} className="kb-sum__chev" />
      </button>
      <Fold id={id} open={open}>
        {made && <div className="kb-ended">{children}</div>}
      </Fold>
    </div>
  )
}

/** A sub-agent that ended: how it ended, its name and how long it took. A click opens its page. */
export function EndedAgent({
  child,
  digest,
}: {
  child: SessionSummary
  digest: SubagentDigestOf['digest']
}) {
  const { t } = useTranslation('board')
  useLoadSubagent(child, true)
  const failed = subagentFailed(child)
  const cancelled = !failed && digest?.stopReason === 'cancelled'
  const took = digest?.durationMs ?? Math.max(0, child.updatedAt - child.createdAt)
  const title = sessionTitle(child)
  return (
    <button
      type="button"
      className="kb-end"
      data-state={failed ? 'failed' : cancelled ? 'stopped' : 'done'}
      aria-label={t('actions.openTitle', { title })}
      onClick={() => openSession(child.id, child.projectPath)}
    >
      <span className="kb-end__mark">
        <PaneIcon icon={failed ? Cancel01Icon : cancelled ? StopIcon : Tick02Icon} size={13} />
      </span>
      <span className="kb-end__name">{title}</span>
      <span className="kb-end__took">
        {failed ? t('status.failed') : cancelled ? t('status.cancelled') : shortDuration(took)}
      </span>
    </button>
  )
}

const TASK_STATE = { completed: 'done', failed: 'failed', stopped: 'stopped' } as const

/** A command that ended. A click opens what it ran and the end of its output in place. */
export function EndedTask({ sessionId, task }: { sessionId: string; task: BackgroundTaskView }) {
  const { t } = useTranslation('board')
  const id = useId()
  const [open, setOpen] = useState(false)
  // Kept once opened, so closing folds it away instead of dropping it.
  const [made, setMade] = useState(false)
  const output = useTaskOutput(sessionId, task.id, { enabled: open, live: false })
  const state = task.status === 'running' ? 'done' : TASK_STATE[task.status]
  const took =
    state === 'failed'
      ? (endedNote(task, t) ?? t('status.failed'))
      : state === 'stopped'
        ? t('status.stopped')
        : shortDuration((task.endedAt ?? task.startedAt) - task.startedAt)
  return (
    <div className="kb-end-item" data-open={open || undefined}>
      <button
        type="button"
        className="kb-end"
        data-state={state}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          setMade(true)
          setOpen(!open)
        }}
      >
        <span className="kb-end__mark">
          <PaneIcon
            icon={state === 'failed' ? Cancel01Icon : state === 'stopped' ? StopIcon : Tick02Icon}
            size={13}
          />
        </span>
        <span className="kb-end__name">{task.title}</span>
        <span className="kb-end__took">{took}</span>
      </button>
      <Fold id={id} open={open}>
        {made && <TaskDetail task={task} output={output} command />}
      </Fold>
    </div>
  )
}
