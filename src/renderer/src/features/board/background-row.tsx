import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ArrowRight01Icon, StopIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { BackgroundTaskView } from '@shared/thread'
import { ToolCallSection } from '@renderer/components/affect/tool-call-card'
import { Printed } from '@renderer/features/session/entries/shell-block'
import { useToolCallLabels } from '@renderer/features/session/entries/tool-call-model'
import { PaneIcon } from '@renderer/features/shell/panel-button'
import { errorMessage, host } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import { endedNote, lastLine } from './board-model'
import { Ago, Elapsed, Row, StatusGlyph, type RowState } from './row-parts'
import { useTaskOutput, type TaskOutput } from './use-task-output'

const STATE: Record<BackgroundTaskView['status'], RowState> = {
  running: 'running',
  completed: 'done',
  failed: 'failed',
  stopped: 'stopped',
}

/**
 * A command or monitor the agent left running, or that ended. A click opens its card with the end
 * of its output, read while the card is open (and the group around it) and the task runs.
 */
export function BackgroundRow({
  sessionId,
  task,
  shown,
}: {
  sessionId: string
  task: BackgroundTaskView
  /** The group around the row is unfolded. */
  shown: boolean
}) {
  const { t } = useTranslation('board')
  const detailId = useId()
  const [open, setOpen] = useState(false)
  // The card is built the first time it opens and kept, so closing it still folds smoothly.
  const [built, setBuilt] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [stopError, setStopError] = useState<string | null>(null)
  const running = task.status === 'running'
  const output = useTaskOutput(sessionId, task.id, { enabled: open && shown, live: running })
  const tail = useMemo(() => (output.text ? lastLine(output.text) : null), [output.text])
  const state = STATE[task.status]

  const stop = () => {
    setStopping(true)
    setStopError(null)
    host('sessions.stopTask', { sessionId, taskId: task.id })
      .catch((error: unknown) => setStopError(errorMessage(error)))
      .finally(() => setStopping(false))
  }

  const kind = task.kind === 'monitor' || task.kind === 'workflow' ? task.kind : null
  return (
    <div className="kb-item">
      <Row
        label={task.title}
        expanded={open}
        controls={detailId}
        onClick={() => {
          setOpen(!open)
          setBuilt(true)
        }}
        glyph={<StatusGlyph state={state} />}
        head={
          <>
            <span className={cn('kb-title', task.kind === 'shell' && 'kb-mono')}>{task.title}</span>
            {kind && <span className="kb-tag">{t(`kind.${kind}`)}</span>}
            {task.status === 'failed' && (
              <span className="kb-pill kb-pill--fail">{t('status.failed')}</span>
            )}
          </>
        }
        detail={running ? tail : (endedNote(task, t) ?? tail)}
        mono
        when={
          running ? <Elapsed since={task.startedAt} /> : <Ago at={task.endedAt ?? task.startedAt} />
        }
        actions={
          running && (
            <button
              type="button"
              className="kb-mini kb-mini--stop"
              aria-label={t('actions.stopTitle', { title: task.title })}
              disabled={stopping}
              onClick={stop}
            >
              <PaneIcon icon={StopIcon} size={13} />
              {t('actions.stop')}
            </button>
          )
        }
        hint={<PaneIcon icon={ArrowRight01Icon} size={14} className="kb-chev-open" />}
      />
      {stopError && (
        <p role="alert" className="kb-row-error">
          {stopError}
        </p>
      )}
      <div id={detailId} className="kb-row-fold" data-open={open}>
        <div>{built && <TaskDetail task={task} output={output} live={running} />}</div>
      </div>
    </div>
  )
}

/** The task's card: what it runs and the end of what it printed, on the Tool Call Card's white. */
function TaskDetail({
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
    <div className="ui-tcc kb-detail" data-selectable="">
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
