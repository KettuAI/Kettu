import { DashboardSquare02Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { usePane } from '@renderer/features/split/pane-context'
import { timeLeft } from '@renderer/lib/format'
import { useSeconds } from '@renderer/lib/use-now'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useThreadsStore } from '@renderer/stores/threads'
import { focusPane, toggleBoard } from '@renderer/stores/view'

interface ScheduleHint {
  /** Nearest fire timestamp (ms) among running one-shot timers, when only timers are scheduled. */
  fireAt: number | null
  /** Cron expression when a single recurring cron is running. */
  cron: string | null
}

function TimerHintText({
  sessionId,
  fireAt,
  reportsBack,
  prefix,
  total,
}: {
  sessionId: string
  fireAt: number
  reportsBack: boolean
  prefix: readonly string[]
  total: number
}) {
  const { t } = useTranslation('session')
  const now = useSeconds()
  const left = timeLeft(Math.max(0, fireAt - now))
  const parts = [...prefix, t('stillRunning.timerLeft', { left })]
  const work = parts.join(t('stillRunning.listSeparator'))
  const text = reportsBack
    ? t('stillRunning.lineReports', { work, count: total })
    : t('stillRunning.line', { work })
  return <StillRunningRow sessionId={sessionId} text={text} />
}

function StillRunningRow({ sessionId, text }: { sessionId: string; text: string }) {
  const { t } = useTranslation('session')
  const pane = usePane()
  const open = () => {
    if (pane && !pane.focused) focusPane(pane.paneId)
    toggleBoard(sessionId, true)
  }
  return (
    <div className="flex min-h-6 min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <HugeiconsIcon
        icon={DashboardSquare02Icon}
        strokeWidth={1.9}
        aria-hidden
        className="size-3.5 shrink-0"
      />
      <span className="min-w-0 truncate">{text}</span>
      <button type="button" className="ks-still__open shrink-0" onClick={open}>
        {t('stillRunning.openBoard')}
      </button>
    </div>
  )
}

/**
 * What the session runs on after its turn ended, as a muted line at the thread's end with the
 * board one click away. It is the host's live count, never a stored entry, so it goes once that
 * work ends or the next turn starts.
 */
export const StillRunningLine = memo(function StillRunningLine({
  sessionId,
}: {
  sessionId: string
}) {
  const { t } = useTranslation('session')
  const work = useSessionsStore(
    useShallow((s) => {
      const still = s.byId[sessionId]?.stillRunning
      return still
        ? {
            commands: still.commands,
            subagents: still.subagents,
            monitors: still.monitors ?? 0,
            scheduled: still.scheduled ?? 0,
            reportsBack: still.reportsBack,
            unnamed: still.unnamed === true,
          }
        : null
    }),
  )
  const hint = useThreadsStore(
    useShallow((s): ScheduleHint => {
      const tasks = s.replicas[sessionId]?.state?.session.background
      if (!tasks || tasks.length === 0) return { fireAt: null, cron: null }
      let fireAt: number | null = null
      let timerCount = 0
      let cron: string | null = null
      let cronCount = 0
      for (const task of tasks) {
        if (task.status !== 'running' || !task.schedule) continue
        if (task.schedule.mode === 'timer' && task.schedule.fireAt !== undefined) {
          timerCount++
          if (fireAt === null || task.schedule.fireAt < fireAt) fireAt = task.schedule.fireAt
        } else if (task.schedule.mode === 'cron' && task.schedule.cron) {
          cronCount++
          if (cron === null) cron = task.schedule.cron
        }
      }
      if (timerCount === 1 && cronCount === 0) return { fireAt, cron: null }
      if (cronCount === 1 && timerCount === 0) return { fireAt: null, cron }
      return { fireAt: null, cron: null }
    }),
  )

  if (!work) return null
  const { commands, subagents, monitors, scheduled } = work
  const total = commands + subagents + monitors + scheduled

  if (total === 0) {
    const text = work.reportsBack
      ? t('stillRunning.lineUnnamedReports')
      : t('stillRunning.lineUnnamed')
    return <StillRunningRow sessionId={sessionId} text={text} />
  }

  // Keep existing phrasing verbatim when only sub-agents and shell commands are running.
  if (monitors === 0 && scheduled === 0) {
    const agents = t('stillRunning.subagents', { count: subagents })
    const shell = t('stillRunning.commands', { count: commands })
    const what =
      commands === 0
        ? agents
        : subagents === 0
          ? shell
          : t('stillRunning.both', { subagents: agents, commands: shell })
    const text = work.reportsBack
      ? t('stillRunning.lineReports', { work: what, count: total })
      : t('stillRunning.line', { work: what })
    return <StillRunningRow sessionId={sessionId} text={text} />
  }

  const prefix: string[] = []
  if (subagents > 0) prefix.push(t('stillRunning.subagents', { count: subagents }))
  if (commands > 0) prefix.push(t('stillRunning.commands', { count: commands }))
  if (monitors > 0) prefix.push(t('stillRunning.monitors', { count: monitors }))

  if (scheduled === 1 && hint.fireAt !== null) {
    return (
      <TimerHintText
        sessionId={sessionId}
        fireAt={hint.fireAt}
        reportsBack={work.reportsBack}
        prefix={prefix}
        total={total}
      />
    )
  }

  if (scheduled > 0) {
    prefix.push(
      scheduled === 1 && hint.cron !== null
        ? t('stillRunning.cronExpr', { cron: hint.cron })
        : t('stillRunning.scheduled', { count: scheduled }),
    )
  }

  const what = prefix.join(t('stillRunning.listSeparator'))
  const text = work.reportsBack
    ? t('stillRunning.lineReports', { work: what, count: total })
    : t('stillRunning.line', { work: what })
  return <StillRunningRow sessionId={sessionId} text={text} />
})
