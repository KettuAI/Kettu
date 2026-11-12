import { useId, useState } from 'react'
import { ComputerTerminal01Icon, StopIcon, ViewIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { SessionSummary } from '@shared/agent-host'
import type { BackgroundTaskView } from '@shared/thread'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Button } from '@renderer/components/ui/button'
import {
  useLoadSubagent,
  type SubagentDigestOf,
} from '@renderer/features/session/subagent/progress'
import { PaneIcon } from '@renderer/features/shell/panel-button'
import { hostOfSession, sessionTitle } from '@renderer/stores/sessions'
import { openSession } from '@renderer/stores/view'
import { askedStep, currentStep, lastLine, subagentWaiting } from './board-model'
import { Clock, Fold } from './row-parts'
import { TaskDetail } from './task-detail'
import { useStopTask } from './use-stop-task'
import { useTaskOutput } from './use-task-output'

// A row that only shows a command's last line reads it less often than an opened one.
const GLANCE_MS = 5_000
const OPEN_MS = 2_000

/**
 * A sub-agent at work: its agent's mark, its name and clock, and under them its type and the
 * step it is on. One that waits for the user is tinted and says what it asks, with Review in
 * the clock's place. A click opens its page. `compact` keeps only the first line.
 */
export function AgentLive({
  child,
  digest,
  compact,
}: {
  child: SessionSummary
  digest: SubagentDigestOf['digest']
  compact: boolean
}) {
  const { t } = useTranslation('board')
  useLoadSubagent(child, true)
  const waiting = subagentWaiting(child)
  const title = sessionTitle(child)
  const open = () => openSession(child.id, child.projectPath)
  const one = compact && !waiting
  return (
    <div className="kb-item" data-wait={waiting || undefined}>
      <div className="kb-live" data-one={one || undefined}>
        <button
          type="button"
          className="kb-hit"
          aria-label={t('actions.openTitle', { title })}
          onClick={open}
        />
        <span className="kb-mark">
          <AgentMark agent={child.agentId} hostId={hostOfSession(child)} size={14} dot={null} />
          {waiting && <i className="kb-mark__badge" />}
        </span>
        <span className="kb-live__name">{title}</span>
        {waiting ? (
          <Button size="xs" className="kb-live__review kb-live__act" onClick={open}>
            {t('actions.review')}
          </Button>
        ) : (
          // A sub-agent that ran before keeps no start for this run, so it shows no time.
          digest?.durationMs == null && (
            <span className="kb-live__end">
              <Clock since={child.createdAt} />
            </span>
          )
        )}
        {!one && (
          <span className="kb-live__what">
            {waiting ? (
              (askedStep(digest, child.projectPath) ?? t('step.waiting'))
            ) : (
              <>
                {child.description && <span className="kb-live__type">{child.description} · </span>}
                <span className="shimmer">
                  {currentStep(digest, child.projectPath) ?? t('step.starting')}
                </span>
              </>
            )}
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * A command or monitor the agent left running: its mark, name and clock, and under them the last
 * line it printed. A click opens it in place, where the second line is the command itself and
 * its output follows; Stop shows beside the clock on hover and stops this one task.
 */
export function TaskLive({
  sessionId,
  task,
  compact,
}: {
  sessionId: string
  task: BackgroundTaskView
  compact: boolean
}) {
  const { t } = useTranslation('board')
  const id = useId()
  const [open, setOpen] = useState(false)
  const output = useTaskOutput(sessionId, task.id, {
    enabled: true,
    live: true,
    every: open ? OPEN_MS : GLANCE_MS,
  })
  const { stop, stopping, error } = useStopTask(sessionId, task.id)
  const command = task.command ?? task.title
  const one = compact && !open
  return (
    <div className="kb-item" data-open={open || undefined}>
      <div className="kb-live" data-kind="task" data-one={one || undefined}>
        <button
          type="button"
          className="kb-hit"
          aria-label={task.title}
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen(!open)}
        />
        <span className="kb-mark">
          <PaneIcon icon={task.kind === 'monitor' ? ViewIcon : ComputerTerminal01Icon} size={14} />
        </span>
        <span className="kb-live__name">{task.title}</span>
        <span className="kb-live__end">
          <button
            type="button"
            className="kb-stop kb-live__act"
            aria-label={t('actions.stopTitle', { title: task.title })}
            title={t('actions.stop')}
            disabled={stopping}
            onClick={stop}
          >
            <PaneIcon icon={StopIcon} size={13} />
          </button>
          <Clock since={task.startedAt} />
        </span>
        {!one && (
          <span className="kb-live__what kb-live__what--mono">
            {open ? command : ((output.text ? lastLine(output.text) : null) ?? command)}
          </span>
        )}
      </div>
      {error && (
        <p role="alert" className="kb-item__error">
          {error}
        </p>
      )}
      <Fold id={id} open={open}>
        <TaskDetail task={task} output={output} onStop={stop} stopping={stopping} />
      </Fold>
    </div>
  )
}
