import { DashboardSquare02Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { usePane } from '@renderer/features/split/pane-context'
import { useSessionsStore } from '@renderer/stores/sessions'
import { focusPane, toggleBoard } from '@renderer/stores/view'

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
  const pane = usePane()
  const work = useSessionsStore(
    useShallow((s) => {
      const still = s.byId[sessionId]?.stillRunning
      return still
        ? { commands: still.commands, subagents: still.subagents, reportsBack: still.reportsBack }
        : null
    }),
  )
  if (!work) return null
  const { commands, subagents } = work
  const agents = t('stillRunning.subagents', { count: subagents })
  const shell = t('stillRunning.commands', { count: commands })
  const what =
    commands === 0
      ? agents
      : subagents === 0
        ? shell
        : t('stillRunning.both', { subagents: agents, commands: shell })
  const text = work.reportsBack
    ? t('stillRunning.lineReports', { work: what, count: commands + subagents })
    : t('stillRunning.line', { work: what })
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
})
