import { useEffect, useRef, useState } from 'react'
import { ComputerTerminal01Icon, StopIcon, ViewIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { BackgroundTaskView } from '@shared/thread'
import {
  ToolCallCard,
  ToolCallSection,
  type ToolCallStatus,
} from '@renderer/components/affect/tool-call-card'
import { Printed } from '@renderer/features/session/entries/shell-block'
import { useToolCallLabels } from '@renderer/features/session/entries/tool-call-model'
import { PaneIcon } from '@renderer/features/shell/panel-button'
import { errorMessage, host } from '@renderer/lib/host'
import { backgroundOrder, endedNote } from './board-model'
import { Finished, Section } from './row-parts'
import { useTaskOutput, type TaskOutput } from './use-task-output'

const STATUS: Record<BackgroundTaskView['status'], ToolCallStatus> = {
  running: 'running',
  completed: 'success',
  failed: 'error',
  stopped: 'cancelled',
}

/**
 * The commands and monitors the agent left running, one Tool Call Card each, with the ended ones
 * folded below. `tasks` is undefined for an agent that does not report them.
 */
export function BackgroundSection({
  sessionId,
  tasks,
  agent,
}: {
  sessionId: string
  tasks: readonly BackgroundTaskView[] | undefined
  agent: string
}) {
  const { t } = useTranslation('board')
  const ordered = tasks ? backgroundOrder(tasks) : []
  const running = ordered.filter((task) => task.status === 'running')
  const ended = ordered.filter((task) => task.status !== 'running')
  return (
    <Section
      icon={ComputerTerminal01Icon}
      title={t('sections.background')}
      {...(tasks ? { count: ordered.length } : {})}
      running={running.length > 0 ? t('sections.running', { count: running.length }) : null}
    >
      {!tasks ? (
        <p className="kb-note">{t('unsupported', { agent })}</p>
      ) : ordered.length === 0 ? (
        <p className="kb-note">{t('none.background')}</p>
      ) : (
        <>
          {running.length > 0 && (
            <div className="kb-stack">
              {running.map((task) => (
                <TaskCard key={task.id} sessionId={sessionId} task={task} />
              ))}
            </div>
          )}
          {ended.length > 0 && (
            <Finished
              count={ended.length}
              failed={ended.filter((task) => task.status === 'failed').length}
              open={running.length === 0}
            >
              <div className="kb-stack">
                {ended.map((task) => (
                  <TaskCard key={task.id} sessionId={sessionId} task={task} />
                ))}
              </div>
            </Finished>
          )}
        </>
      )}
    </Section>
  )
}

/**
 * A command or monitor: what it does in the agent's words and its clock. Open, it shows the
 * command and reads the end of its output, again every 2 s while it runs; Stop shows on hover
 * and stops this one task.
 */
function TaskCard({ sessionId, task }: { sessionId: string; task: BackgroundTaskView }) {
  const { t } = useTranslation('board')
  const labels = useToolCallLabels()
  const [open, setOpen] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [stopError, setStopError] = useState<string | null>(null)
  const running = task.status === 'running'
  const output = useTaskOutput(sessionId, task.id, { enabled: open, live: running })

  const stop = () => {
    setStopping(true)
    setStopError(null)
    host('sessions.stopTask', { sessionId, taskId: task.id })
      .catch((error: unknown) => setStopError(errorMessage(error)))
      .finally(() => setStopping(false))
  }

  const note = endedNote(task, t)
  return (
    <div className="kb-task">
      <ToolCallCard
        name={task.title}
        icon={
          <PaneIcon icon={task.kind === 'monitor' ? ViewIcon : ComputerTerminal01Icon} size={14} />
        }
        status={STATUS[task.status]}
        startedAt={task.startedAt}
        {...(task.endedAt === null ? {} : { duration: task.endedAt - task.startedAt })}
        {...(task.status === 'failed' && note ? { error: note } : {})}
        openOnError={false}
        open={open}
        onOpenChange={setOpen}
        chevron="before"
        labels={labels}
        trail={
          running && (
            <button
              type="button"
              className="kb-stop"
              aria-label={t('actions.stopTitle', { title: task.title })}
              title={t('actions.stop')}
              disabled={stopping}
              onClick={stop}
            >
              <PaneIcon icon={StopIcon} size={13} />
            </button>
          )
        }
      >
        {open ? <TaskBody task={task} output={output} live={running} /> : null}
      </ToolCallCard>
      {stopError && (
        <p role="alert" className="kb-row-error">
          {stopError}
        </p>
      )}
    </div>
  )
}

/** What the task runs and the end of what it printed. */
function TaskBody({
  task,
  output,
  live,
}: {
  task: BackgroundTaskView
  output: TaskOutput
  live: boolean
}) {
  const { t } = useTranslation('board')
  const labels = useToolCallLabels()
  const pre = useRef<HTMLPreElement>(null)
  // The tail stays in view while the user has not scrolled up from it.
  const atEnd = useRef(true)
  useEffect(() => {
    const element = pre.current
    if (element && atEnd.current) element.scrollTop = element.scrollHeight
  }, [output.text])

  const notes = [output.truncated && t('detail.truncated'), live && t('detail.refreshed')].filter(
    Boolean,
  )
  return (
    <div className="kb-detail" data-selectable="">
      <div className="ks-shell">
        <ToolCallSection
          label={t(task.kind === 'monitor' ? 'detail.watching' : 'detail.command')}
          copy={task.command ?? task.title}
          labels={labels}
        >
          <pre className="ks-shell-command">{task.command ?? task.title}</pre>
        </ToolCallSection>
        <ToolCallSection label={t('detail.output')} copy={output.text || undefined} labels={labels}>
          {output.text ? (
            <pre
              ref={pre}
              className="kb-output"
              onScroll={(event) => {
                const { scrollTop, clientHeight, scrollHeight } = event.currentTarget
                atEnd.current = scrollHeight - scrollTop - clientHeight < 8
              }}
            >
              <Printed text={output.text.replace(/\n$/, '')} />
            </pre>
          ) : (
            output.text === '' && <p className="ks-shell-none">{t('detail.noOutput')}</p>
          )}
          {output.error && (
            <p role="alert" className="kb-detail__error">
              {t('detail.readFailed', { error: output.error })}
            </p>
          )}
        </ToolCallSection>
      </div>
      {notes.length > 0 && <p className="kb-detail__note">{notes.join(' ')}</p>}
    </div>
  )
}
